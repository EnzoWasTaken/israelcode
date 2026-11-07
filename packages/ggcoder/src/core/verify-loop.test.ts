import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVerifyFixMessage,
  loadVerifyConfig,
  runVerifyLoop,
  saveVerifyConfig,
  turnWroteFiles,
  type RunCommandOutcome,
  type VerifyCommandSpec,
} from "./verify-loop.js";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-loop-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("loadVerifyConfig", () => {
  it("detects test / typecheck / lint from package.json when there is no file", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", build: "x" },
      }),
    );
    await fs.writeFile(path.join(cwd, "index.ts"), "export {};\n");
    const cfg = await loadVerifyConfig(cwd);
    expect(cfg.source).toBe("detected");
    expect(cfg.maxRounds).toBe(3);
    expect(cfg.commands.map((c) => c.label)).toEqual(["test", "typecheck", "lint"]);
    expect(cfg.commands[0]!.command).toMatch(/test$/);
  });

  it("prefers a well-formed .gg/verify.json and dedupes identical commands", async () => {
    await fs.mkdir(path.join(cwd, ".gg"));
    await fs.writeFile(
      path.join(cwd, ".gg", "verify.json"),
      JSON.stringify({
        version: 1,
        commands: [
          { label: "test", command: "npm test" },
          { label: "again", command: "npm test" },
          { label: "types", command: " tsc --noEmit " },
        ],
        maxRounds: 99,
      }),
    );
    expect(await loadVerifyConfig(cwd)).toEqual({
      commands: [
        { label: "test", command: "npm test" },
        { label: "types", command: "tsc --noEmit" },
      ],
      maxRounds: 10,
      source: "file",
    });
  });

  it("falls back to detection when the file is malformed", async () => {
    await fs.mkdir(path.join(cwd, ".gg"));
    await fs.writeFile(path.join(cwd, ".gg", "verify.json"), "{nope");
    const cfg = await loadVerifyConfig(cwd);
    expect(cfg).toEqual({ commands: [], maxRounds: 3, source: "detected" });
  });

  it("round-trips through saveVerifyConfig", async () => {
    const saved = await saveVerifyConfig(cwd, {
      commands: [{ label: "test", command: "npm test" }],
      maxRounds: 2,
    });
    expect(saved).toEqual({
      commands: [{ label: "test", command: "npm test" }],
      maxRounds: 2,
      source: "file",
    });
    expect(await loadVerifyConfig(cwd)).toEqual(saved);
    const file = JSON.parse(await fs.readFile(path.join(cwd, ".gg", "verify.json"), "utf-8"));
    expect(file).toEqual({
      version: 1,
      commands: [{ label: "test", command: "npm test" }],
      maxRounds: 2,
    });
    await expect(
      saveVerifyConfig(cwd, { commands: [{ label: "", command: "x" }] }),
    ).rejects.toThrow();
  });
});

describe("buildVerifyFixMessage", () => {
  it("names the round, each failing check and what to do", () => {
    const text = buildVerifyFixMessage(1, 3, [
      { label: "test", command: "npm test", exitCode: 1, tail: "FAIL a.test.ts\n  expected 2" },
      { label: "lint", command: "eslint .", exitCode: null, tail: "" },
    ]);
    expect(text).toBe(
      "Verify round 1/3: these checks failed after your changes — test (`npm test`, exit 1):\n" +
        "FAIL a.test.ts\n  expected 2\n\nlint (`eslint .`, no exit code):\n(no output)\n\n" +
        "Fix the cause (not the test, unless the test itself is wrong), re-run the failing check, then stop.",
    );
  });
});

const CMDS: VerifyCommandSpec[] = [
  { label: "test", command: "t" },
  { label: "lint", command: "l" },
];

function outcome(exitCode: number, tail = ""): RunCommandOutcome {
  return { exitCode, durationMs: 5, tail, cancelled: false };
}

describe("runVerifyLoop", () => {
  it("stops on the first all-pass round and reports progress per command", async () => {
    const onProgress = vi.fn();
    const fixRound = vi.fn(async () => {});
    const result = await runVerifyLoop({
      commands: CMDS,
      maxRounds: 3,
      runCommand: async () => outcome(0, "ok"),
      fixRound,
      onProgress,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      passed: true,
      stoppedReason: "passed",
      rounds: [
        {
          round: 1,
          results: [
            { label: "test", command: "t", exitCode: 0, durationMs: 5, tail: "ok" },
            { label: "lint", command: "l", exitCode: 0, durationMs: 5, tail: "ok" },
          ],
        },
      ],
    });
    expect(fixRound).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      { round: 1, maxRounds: 3, label: "test", command: "t", status: "running" },
      {
        round: 1,
        maxRounds: 3,
        label: "test",
        command: "t",
        status: "pass",
        exitCode: 0,
        durationMs: 5,
        tail: "ok",
      },
      { round: 1, maxRounds: 3, label: "lint", command: "l", status: "running" },
      {
        round: 1,
        maxRounds: 3,
        label: "lint",
        command: "l",
        status: "pass",
        exitCode: 0,
        durationMs: 5,
        tail: "ok",
      },
    ]);
  });

  it("feeds only the failures to a fix round, then re-checks", async () => {
    let testRuns = 0;
    const fixRound = vi.fn(async () => {});
    const result = await runVerifyLoop({
      commands: CMDS,
      maxRounds: 3,
      runCommand: async (c) => {
        if (c.label === "lint") return outcome(0);
        testRuns++;
        return testRuns === 1 ? outcome(1, "boom") : outcome(0);
      },
      fixRound,
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(true);
    expect(result.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(fixRound).toHaveBeenCalledTimes(1);
    const [failures, message, round] = fixRound.mock.calls[0] as unknown as [
      { label: string }[],
      string,
      number,
    ];
    expect(failures.map((f) => f.label)).toEqual(["test"]);
    expect(round).toBe(1);
    expect(message).toContain("Verify round 1/3");
    expect(message).toContain("boom");
    expect(message).not.toContain("lint");
  });

  it("gives up after the cap without a trailing fix round", async () => {
    const fixRound = vi.fn(async () => {});
    const result = await runVerifyLoop({
      commands: CMDS,
      maxRounds: 2,
      runCommand: async () => outcome(1),
      fixRound,
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(false);
    expect(result.stoppedReason).toBe("max-rounds");
    expect(result.rounds).toHaveLength(2);
    expect(fixRound).toHaveBeenCalledTimes(1);
  });

  it("reports cancellation from a stopped command or an aborted fix round", async () => {
    const cancelled = await runVerifyLoop({
      commands: CMDS,
      maxRounds: 3,
      runCommand: async () => ({ exitCode: null, durationMs: 1, tail: "", cancelled: true }),
      fixRound: async () => {},
      signal: new AbortController().signal,
    });
    expect(cancelled.stoppedReason).toBe("cancelled");
    expect(cancelled.rounds[0]!.results).toHaveLength(1);

    const ac = new AbortController();
    const aborted = await runVerifyLoop({
      commands: CMDS,
      maxRounds: 3,
      runCommand: async () => outcome(1),
      fixRound: async () => {
        ac.abort();
        throw new Error("aborted");
      },
      signal: ac.signal,
    });
    expect(aborted).toMatchObject({ passed: false, stoppedReason: "cancelled" });
  });

  it("does nothing without commands", async () => {
    const runCommand = vi.fn();
    const result = await runVerifyLoop({
      commands: [],
      maxRounds: 3,
      runCommand,
      fixRound: async () => {},
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ passed: true, rounds: [], stoppedReason: "no-commands" });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("turnWroteFiles", () => {
  it("is true only for write/edit tools", () => {
    expect(turnWroteFiles([{ name: "read" }, { name: "bash" }])).toBe(false);
    expect(turnWroteFiles([{ name: "read" }, { name: "edit" }])).toBe(true);
    expect(turnWroteFiles([{ name: "write" }])).toBe(true);
    expect(turnWroteFiles([])).toBe(false);
  });
});
