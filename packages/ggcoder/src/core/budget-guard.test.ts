import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDayUsage,
  BudgetGuard,
  budgetLedgerFile,
  pruneLedger,
  readBudgetLedger,
  readDayUsage,
  RunawayDetector,
} from "./budget-guard.js";

const turn = (inputTokens: number, outputTokens = 0) => ({ inputTokens, outputTokens });

describe("BudgetGuard", () => {
  it("has no caps by default and never warns or stops", () => {
    const guard = new BudgetGuard({ hardStopOnRunaway: true });
    const result = guard.recordTurn(turn(5_000_000, 5_000_000));
    expect(result).toMatchObject({ warnings: [], stop: false });
    expect(result.status).toEqual({
      sessionUsed: 10_000_000,
      sessionCap: null,
      dayUsed: 10_000_000,
      dayCap: null,
      level: "ok",
      overridden: false,
    });
  });

  it("warns once at 50% and once at 80% of the session cap, then stops at 100%", () => {
    const guard = new BudgetGuard({ sessionTokens: 1000, hardStopOnRunaway: true });
    expect(guard.recordTurn(turn(400, 100)).warnings).toEqual(["warn50"]);
    expect(guard.recordTurn(turn(100)).warnings).toEqual([]);
    const at80 = guard.recordTurn(turn(200));
    expect(at80.warnings).toEqual(["warn80"]);
    expect(at80.crossings).toEqual([{ level: "warn80", scope: "session", cap: 1000, used: 800 }]);
    expect(at80.status.level).toBe("warn80");
    const over = guard.recordTurn(turn(300));
    expect(over).toMatchObject({ warnings: [], stop: true });
    expect(over.status).toMatchObject({ sessionUsed: 1100, level: "exceeded" });
    // Still exceeded on the next turn: the stop is not one-shot.
    expect(guard.recordTurn(turn(1)).stop).toBe(true);
  });

  it("fires both warnings when one turn jumps past them, and none past the cap", () => {
    const guard = new BudgetGuard({ sessionTokens: 1000, hardStopOnRunaway: true });
    expect(guard.recordTurn(turn(900)).warnings).toEqual(["warn50", "warn80"]);
    const other = new BudgetGuard({ sessionTokens: 1000, hardStopOnRunaway: true });
    const result = other.recordTurn(turn(5000));
    expect(result.warnings).toEqual([]);
    expect(result.stop).toBe(true);
  });

  it("tracks the day cap separately, adopting a ledger total when given one", () => {
    const guard = new BudgetGuard({ dayTokens: 2000, hardStopOnRunaway: true }, { dayUsed: 1100 });
    // 1100 already spent today by other windows: 50% is behind us, no warning.
    const first = guard.recordTurn(turn(50), 1150);
    expect(first.warnings).toEqual([]);
    expect(first.status).toMatchObject({ sessionUsed: 50, dayUsed: 1150, level: "warn50" });
    const second = guard.recordTurn(turn(100), 1700);
    expect(second.crossings).toEqual([{ level: "warn80", scope: "day", cap: 2000, used: 1700 }]);
    expect(guard.recordTurn(turn(100), 2100)).toMatchObject({
      stop: true,
      status: { level: "exceeded", dayUsed: 2100, sessionUsed: 250 },
    });
  });

  it("reports the worse of the two caps as the level", () => {
    const guard = new BudgetGuard({
      sessionTokens: 1000,
      dayTokens: 100_000,
      hardStopOnRunaway: true,
    });
    expect(guard.recordTurn(turn(850)).status.level).toBe("warn80");
  });

  it("Continue anyway lifts the stop until the caps are configured again", () => {
    const guard = new BudgetGuard({ sessionTokens: 100, hardStopOnRunaway: true });
    expect(guard.recordTurn(turn(150)).stop).toBe(true);
    expect(guard.allowOverride()).toMatchObject({ level: "exceeded", overridden: true });
    expect(guard.recordTurn(turn(50))).toMatchObject({ stop: false, warnings: [] });
    const rearmed = guard.configure({ sessionTokens: 150, hardStopOnRunaway: false });
    expect(rearmed).toMatchObject({ overridden: false, level: "exceeded", sessionCap: 150 });
    expect(guard.hardStopOnRunaway).toBe(false);
    expect(guard.recordTurn(turn(1)).stop).toBe(true);
  });

  it("re-arming with a higher cap keeps the thresholds already behind us quiet", () => {
    const guard = new BudgetGuard({ sessionTokens: 100, hardStopOnRunaway: true });
    guard.recordTurn(turn(90));
    expect(guard.configure({ sessionTokens: 160, hardStopOnRunaway: true }).level).toBe("warn50");
    // 90/160 is past 50% already: only the 80% line is still ahead.
    expect(guard.recordTurn(turn(10)).warnings).toEqual([]);
    expect(guard.recordTurn(turn(30)).warnings).toEqual(["warn80"]);
    // Removing the cap altogether clears everything.
    expect(guard.configure({ hardStopOnRunaway: true })).toMatchObject({
      sessionCap: null,
      level: "ok",
    });
  });

  it("ignores non-positive or non-finite caps", () => {
    const guard = new BudgetGuard({
      sessionTokens: 0,
      dayTokens: Number.NaN,
      hardStopOnRunaway: true,
    });
    expect(guard.status()).toMatchObject({ sessionCap: null, dayCap: null });
  });
});

describe("day ledger", () => {
  let home = "";
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-budget-ledger-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("adds per project per day, returns the running total and survives a reread", async () => {
    const opts = { home, today: "2026-11-06" };
    expect(await readDayUsage("/p/a", opts)).toBe(0);
    expect(await addDayUsage("/p/a", 100, opts)).toBe(100);
    expect(await addDayUsage("/p/a", 250, opts)).toBe(350);
    expect(await addDayUsage("/p/b", 7, opts)).toBe(7);
    expect(await readDayUsage("/p/a", opts)).toBe(350);
    expect(await readDayUsage("/p/a", { home, today: "2026-11-07" })).toBe(0);
    const ledger = await readBudgetLedger(budgetLedgerFile(home));
    expect(ledger).toEqual({
      version: 1,
      days: { "2026-11-06": { "/p/a": 350, "/p/b": 7 } },
    });
  });

  it("prunes days older than two weeks on write and tolerates a broken file", async () => {
    const file = budgetLedgerFile(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        days: {
          "2026-10-20": { "/p/a": 5 },
          "2026-10-23": { "/p/a": 9 },
          "not-a-day": { "/p/a": 1 },
          "2026-11-05": { "/p/a": "lots" },
        },
      }),
    );
    await addDayUsage("/p/a", 1, { home, today: "2026-11-06" });
    expect((await readBudgetLedger(file)).days).toEqual({
      "2026-10-23": { "/p/a": 9 },
      "2026-11-05": {},
      "2026-11-06": { "/p/a": 1 },
    });
    await fs.writeFile(file, "{nope");
    expect(await readDayUsage("/p/a", { home, today: "2026-11-06" })).toBe(0);
    expect(await addDayUsage("/p/a", 3, { home, today: "2026-11-06" })).toBe(3);
  });

  it("pruneLedger keeps exactly the window", () => {
    const pruned = pruneLedger(
      { version: 1, days: { "2026-10-22": {}, "2026-10-23": {}, "2026-11-06": {} } },
      "2026-11-06",
    );
    expect(Object.keys(pruned.days)).toEqual(["2026-10-23", "2026-11-06"]);
  });
});

describe("RunawayDetector", () => {
  const quiet = {
    consecutiveFailures: 0,
    repeatedNoProgressCalls: 0,
    textRepetitionDetected: false,
  };
  const detector = new RunawayDetector();

  it("stays quiet while the loop-breaker is still nudging", () => {
    expect(detector.evaluate({ ...quiet, consecutiveFailures: 3 }, 2)).toEqual({
      shouldHardStop: false,
      reasons: [],
    });
  });

  it("stops after three nudges, eight failures in a row or six identical no-progress calls", () => {
    expect(detector.evaluate(quiet, 3).shouldHardStop).toBe(true);
    expect(detector.evaluate({ ...quiet, consecutiveFailures: 8 }, 0).reasons).toEqual([
      "8 failed tool calls in a row",
    ]);
    const both = detector.evaluate(
      { ...quiet, consecutiveFailures: 9, repeatedNoProgressCalls: 6 },
      3,
    );
    expect(both.shouldHardStop).toBe(true);
    expect(both.reasons).toHaveLength(3);
  });
});
