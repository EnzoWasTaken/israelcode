import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir so the
// route's gg-app.json and ledger writes never touch the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { handleBudgetRoutes } = await import("./budget-routes.js");
const { createBudgetController } = await import("./budget.js");
const { loadBudgetPref } = await import("./app-settings.js");
const { readDayUsage } = await import("../core/budget-guard.js");
const { EventBus } = await import("../core/event-bus.js");

interface Reply {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: http.ServerResponse; reply: Promise<Reply> } {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  return { res: res as unknown as http.ServerResponse, reply };
}

const TODAY = "2026-11-06";

function makeController(
  config: { sessionTokens?: number; dayTokens?: number; hardStopOnRunaway: boolean },
  extra: { nudges?: number; failures?: number; dayUsed?: number } = {},
) {
  const broadcast = vi.fn();
  const stopRun = vi.fn(async () => {});
  const controller = createBudgetController({
    projectKey: "/proj",
    config,
    dayUsed: extra.dayUsed ?? 0,
    broadcast,
    stopRun,
    loopBreakStats: () => ({
      consecutiveFailures: extra.failures ?? 0,
      repeatedNoProgressCalls: 0,
      textRepetitionDetected: false,
      nudgesThisRun: extra.nudges ?? 0,
    }),
    ledger: { home, today: () => TODAY },
  });
  return { controller, broadcast, stopRun };
}

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const { controller, broadcast } = makeController({ hardStopOnRunaway: true });
  return {
    mode: "code",
    goal: null,
    cwd: path.join(home, "proj"),
    budget: controller,
    broadcast,
    ...overrides,
  };
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleBudgetRoutes(
      ctx as unknown as SessionRouteContext,
      req as unknown as http.IncomingMessage,
      res,
      url,
      method,
    ),
  ).toBe(true);
  return reply;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-budget-routes-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("GET /budget", () => {
  it("returns the caps and the meter", async () => {
    const reply = await call(makeCtx(), "/budget", undefined, "GET");
    expect(reply).toEqual({
      status: 200,
      body: {
        config: { hardStopOnRunaway: true },
        status: {
          sessionUsed: 0,
          sessionCap: null,
          dayUsed: 0,
          dayCap: null,
          level: "ok",
          overridden: false,
        },
      },
    });
  });
});

describe("POST /budget", () => {
  it("saves the caps per project, re-arms the live guard and broadcasts", async () => {
    const ctx = makeCtx();
    const reply = await call(ctx, "/budget", {
      sessionTokens: 200_000,
      dayTokens: null,
      hardStopOnRunaway: false,
    });
    expect(reply.status).toBe(200);
    expect((reply.body as { config: unknown }).config).toEqual({
      sessionTokens: 200_000,
      hardStopOnRunaway: false,
    });
    expect(await loadBudgetPref(ctx.cwd)).toEqual({
      sessionTokens: 200_000,
      hardStopOnRunaway: false,
    });
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "budget_state",
      expect.objectContaining({ sessionCap: 200_000, level: "ok" }),
    );
  });

  it("rejects a malformed body or a cap that is not a positive number", async () => {
    const ctx = makeCtx();
    expect((await call(ctx, "/budget", { sessionTokens: -1 })).status).toBe(400);
    expect((await call(ctx, "/budget", { dayTokens: "lots" })).status).toBe(400);
    const { res, reply } = fakeResponse();
    handleBudgetRoutes(
      ctx as unknown as SessionRouteContext,
      Readable.from([Buffer.from("{nope")]) as unknown as http.IncomingMessage,
      res,
      "/budget",
      "POST",
    );
    expect((await reply).status).toBe(400);
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });
});

describe("POST /budget/continue", () => {
  it("lifts the stop and returns the overridden status", async () => {
    const ctx = makeCtx();
    const reply = await call(ctx, "/budget/continue");
    expect((reply.body as { status: { overridden: boolean } }).status.overridden).toBe(true);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "budget_state",
      expect.objectContaining({ overridden: true }),
    );
  });
});

describe("route scope", () => {
  it("is only for coding sessions with a controller", async () => {
    expect((await call(makeCtx({ goal: { dir: "x" } }), "/budget", undefined, "GET")).status).toBe(
      404,
    );
    expect((await call(makeCtx({ mode: "chat" }), "/budget", undefined, "GET")).status).toBe(404);
    expect((await call(makeCtx({ budget: null }), "/budget/continue")).status).toBe(404);
  });

  it("ignores other paths and methods", () => {
    const { res } = fakeResponse();
    const ctx = makeCtx() as unknown as SessionRouteContext;
    expect(handleBudgetRoutes(ctx, {} as http.IncomingMessage, res, "/budgets", "GET")).toBe(false);
    expect(handleBudgetRoutes(ctx, {} as http.IncomingMessage, res, "/budget", "DELETE")).toBe(
      false,
    );
    expect(handleBudgetRoutes(ctx, {} as http.IncomingMessage, res, "/budget/other", "POST")).toBe(
      false,
    );
  });
});

describe("budget controller", () => {
  it("counts turns and children into the day ledger, warns and stops the run", async () => {
    const { controller, broadcast, stopRun } = makeController({
      sessionTokens: 1000,
      hardStopOnRunaway: true,
    });
    const bus = new EventBus();
    controller.attach(bus);
    bus.emit("turn_end", {
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 400, outputTokens: 100 },
      timing: {},
    } as never);
    await controller.recordUsage({ inputTokens: 0, outputTokens: 0 });
    expect(broadcast).toHaveBeenCalledWith("budget_warning", {
      level: "warn50",
      scope: "session",
      cap: 1000,
      used: 500,
    });
    expect(await readDayUsage("/proj", { home, today: TODAY })).toBe(500);

    // A child reports cumulative totals: only the growth counts, once.
    await controller.recordChildSnapshot("a1", { input: 200, output: 100 });
    await controller.recordChildSnapshot("a1", { input: 200, output: 100 });
    expect(controller.statePayload().status).toMatchObject({
      sessionUsed: 800,
      dayUsed: 800,
      level: "warn80",
    });
    expect(stopRun).not.toHaveBeenCalled();

    await controller.recordChildSnapshot("a1", { input: 500, output: 100 });
    expect(stopRun).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("budget_exceeded", {
      status: expect.objectContaining({ level: "exceeded", sessionUsed: 1100 }),
    });

    // Still over the cap in the next run: stopped again, once.
    controller.noteRunStart();
    await controller.recordUsage({ inputTokens: 10, outputTokens: 0 });
    await controller.recordUsage({ inputTokens: 10, outputTokens: 0 });
    expect(stopRun).toHaveBeenCalledTimes(2);
    // Continue anyway: the next turn no longer stops.
    controller.allowOverride();
    controller.noteRunStart();
    await controller.recordUsage({ inputTokens: 10, outputTokens: 0 });
    expect(stopRun).toHaveBeenCalledTimes(2);
  });

  it("stops a runaway run only when the hard stop is on", async () => {
    const on = makeController({ hardStopOnRunaway: true }, { nudges: 3 });
    const bus = new EventBus();
    on.controller.attach(bus);
    bus.emit("hook", { kind: "loop_break" });
    await on.controller.checkRunaway();
    expect(on.stopRun).toHaveBeenCalledTimes(1);
    expect(on.broadcast).toHaveBeenCalledWith("runaway_stopped", {
      reasons: ["3 loop-break nudges in one run with no change"],
    });

    const off = makeController({ hardStopOnRunaway: false }, { failures: 20 });
    await off.controller.checkRunaway();
    expect(off.stopRun).not.toHaveBeenCalled();
  });
});
