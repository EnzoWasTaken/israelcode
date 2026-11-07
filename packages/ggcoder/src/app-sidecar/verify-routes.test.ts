import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import type { RunCommandOutcome, VerifyCommandSpec } from "../core/verify-loop.js";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir so the
// route's gg-app.json writes never touch the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { handleVerifyRoutes } = await import("./verify-routes.js");
const { createVerifyController, restoreVerifyMarker } = await import("./verify.js");
const { loadVerifyEnabled } = await import("./app-settings.js");
const { loadVerifyConfig } = await import("../core/verify-loop.js");

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

const CMDS: VerifyCommandSpec[] = [
  { label: "test", command: "t" },
  { label: "lint", command: "l" },
];

function makeController(opts: {
  enabled?: boolean;
  runCommand?: (c: VerifyCommandSpec, signal: AbortSignal) => Promise<RunCommandOutcome>;
  fixRound?: (message: string) => Promise<void>;
  commands?: VerifyCommandSpec[];
}) {
  const broadcast = vi.fn();
  const persistMarker = vi.fn(async () => {});
  const fixRound = vi.fn(opts.fixRound ?? (async () => {}));
  const controller = createVerifyController({
    cwd: path.join(home, "proj"),
    enabled: opts.enabled ?? true,
    config: { commands: opts.commands ?? CMDS, maxRounds: 3, source: "file" },
    broadcast,
    fixRound,
    persistMarker,
    runCommand:
      opts.runCommand ??
      (async () => ({ exitCode: 0, durationMs: 1, tail: "ok", cancelled: false })),
  });
  return { controller, broadcast, persistMarker, fixRound };
}

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const { controller, broadcast } = makeController({ enabled: false });
  const runAgent = vi.fn(async (_label: string, run: () => Promise<void>) => {
    await run();
  });
  return {
    mode: "code",
    goal: null,
    cwd: path.join(home, "proj"),
    verify: controller,
    broadcast,
    running: false,
    runAgent,
    ...overrides,
  };
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleVerifyRoutes(
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-routes-"));
  await fs.mkdir(path.join(home, "proj"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("GET /verify", () => {
  it("returns the switch, the config and whether a loop runs", async () => {
    const reply = await call(makeCtx(), "/verify", undefined, "GET");
    expect(reply).toEqual({
      status: 200,
      body: {
        enabled: false,
        config: { commands: CMDS, maxRounds: 3, source: "file" },
        running: false,
      },
    });
  });
});

describe("POST /verify", () => {
  it("saves the switch to gg-app.json and the commands to .gg/verify.json, then broadcasts", async () => {
    const ctx = makeCtx();
    const reply = await call(ctx, "/verify", {
      enabled: true,
      commands: [{ label: "test", command: "npm test" }],
      maxRounds: 2,
    });
    expect(reply).toEqual({
      status: 200,
      body: {
        enabled: true,
        config: {
          commands: [{ label: "test", command: "npm test" }],
          maxRounds: 2,
          source: "file",
        },
        running: false,
      },
    });
    expect(await loadVerifyEnabled(ctx.cwd)).toBe(true);
    expect(await loadVerifyConfig(ctx.cwd)).toEqual({
      commands: [{ label: "test", command: "npm test" }],
      maxRounds: 2,
      source: "file",
    });
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "verify_state",
      expect.objectContaining({ enabled: true }),
    );
    // Only the switch: the commands stay as they were.
    await call(ctx, "/verify", { enabled: false });
    expect(await loadVerifyEnabled(ctx.cwd)).toBe(false);
    expect(ctx.verify.config.commands).toEqual([{ label: "test", command: "npm test" }]);
  });

  it("rejects a malformed body", async () => {
    const ctx = makeCtx();
    expect((await call(ctx, "/verify", { enabled: "yes" })).status).toBe(400);
    expect((await call(ctx, "/verify", { commands: [{ label: "x" }] })).status).toBe(400);
    expect((await call(ctx, "/verify", { maxRounds: 0 })).status).toBe(400);
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });
});

describe("POST /verify/run", () => {
  it("starts the loop inside runAgent and refuses while a run is active", async () => {
    const ctx = makeCtx();
    expect(await call(ctx, "/verify/run")).toEqual({ status: 200, body: { started: true } });
    expect(ctx.runAgent).toHaveBeenCalledWith("Verify", expect.any(Function));
    await vi.waitFor(() => {
      expect(ctx.broadcast).toHaveBeenCalledWith(
        "verify_result",
        expect.objectContaining({ passed: true }),
      );
    });
    expect((await call(makeCtx({ running: true }), "/verify/run")).status).toBe(409);
  });
});

describe("route scope", () => {
  it("is only for coding sessions with a controller", async () => {
    expect((await call(makeCtx({ goal: { dir: "x" } }), "/verify", undefined, "GET")).status).toBe(
      404,
    );
    expect((await call(makeCtx({ mode: "chat" }), "/verify", undefined, "GET")).status).toBe(404);
    expect((await call(makeCtx({ verify: null }), "/verify/run")).status).toBe(404);
  });

  it("ignores other paths and methods", () => {
    const { res } = fakeResponse();
    const ctx = makeCtx() as unknown as SessionRouteContext;
    expect(handleVerifyRoutes(ctx, {} as http.IncomingMessage, res, "/verified", "GET")).toBe(
      false,
    );
    expect(handleVerifyRoutes(ctx, {} as http.IncomingMessage, res, "/verify", "DELETE")).toBe(
      false,
    );
    expect(handleVerifyRoutes(ctx, {} as http.IncomingMessage, res, "/verify/other", "POST")).toBe(
      false,
    );
  });
});

describe("verify controller", () => {
  it("runs the loop, broadcasts progress and the result, persists a marker, and fixes once", async () => {
    let testRuns = 0;
    const { controller, broadcast, persistMarker, fixRound } = makeController({
      runCommand: async (c) => {
        if (c.label === "lint") return { exitCode: 0, durationMs: 1, tail: "", cancelled: false };
        testRuns++;
        return testRuns === 1
          ? { exitCode: 1, durationMs: 2, tail: "FAIL", cancelled: false }
          : { exitCode: 0, durationMs: 2, tail: "", cancelled: false };
      },
    });
    const result = await controller.start();
    expect(result).toMatchObject({ passed: true, stoppedReason: "passed" });
    expect(result!.rounds).toHaveLength(2);
    expect(fixRound).toHaveBeenCalledTimes(1);
    expect(fixRound.mock.calls[0]![0]).toContain("Verify round 1/3");
    expect(broadcast).toHaveBeenCalledWith("verify_progress", {
      round: 1,
      maxRounds: 3,
      label: "test",
      command: "t",
      status: "fail",
      exitCode: 1,
      durationMs: 2,
      tail: "FAIL",
    });
    expect(broadcast).toHaveBeenCalledWith("verify_result", result);
    expect(persistMarker).toHaveBeenCalledWith(result);
    const marker = (persistMarker.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(restoreVerifyMarker(marker)).toEqual(result);
    expect(controller.running).toBe(false);
  });

  it("cancels a running loop and refuses a second start meanwhile", async () => {
    let release: () => void = () => {};
    const { controller, broadcast, persistMarker } = makeController({
      runCommand: (_c, signal) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exitCode: null, durationMs: 1, tail: "", cancelled: signal.aborted });
          signal.addEventListener("abort", release, { once: true });
        }),
    });
    const first = controller.start();
    expect(controller.running).toBe(true);
    expect(await controller.start()).toBeNull();
    controller.cancel();
    const result = await first;
    expect(result).toMatchObject({ passed: false, stoppedReason: "cancelled" });
    expect(broadcast).toHaveBeenCalledWith("verify_result", result);
    expect(persistMarker).toHaveBeenCalledTimes(1);
  });

  it("skips the marker when there is nothing to run", async () => {
    const { controller, persistMarker, broadcast } = makeController({ commands: [] });
    expect(await controller.start()).toEqual({
      passed: true,
      rounds: [],
      stoppedReason: "no-commands",
    });
    expect(persistMarker).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("verify_result", expect.anything());
  });
});
