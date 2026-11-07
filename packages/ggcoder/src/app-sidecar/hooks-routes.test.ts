import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import type { HookRunResult } from "../core/hook-wrap.js";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir so the
// route's gg-app.json writes never touch the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { handleHooksRoutes } = await import("./hooks-routes.js");
const { createHooksController, notifyBody } = await import("./hooks.js");
const { loadHooksEnabled } = await import("./app-settings.js");
const { defaultHooksConfig, loadHooksConfig } = await import("../core/hook-presets.js");

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

function makeController(opts: {
  enabled?: boolean;
  runCommand?: (command: string, timeoutMs: number, signal: AbortSignal) => Promise<HookRunResult>;
}) {
  const broadcast = vi.fn();
  const controller = createHooksController({
    cwd: path.join(home, "proj"),
    enabled: opts.enabled ?? false,
    config: defaultHooksConfig(),
    broadcast,
    runCommand: opts.runCommand ?? (async () => ({ exitCode: 0, tail: "" })),
  });
  return { controller, broadcast };
}

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const { controller, broadcast } = makeController({});
  return {
    mode: "code",
    goal: null,
    cwd: path.join(home, "proj"),
    hooks: controller,
    broadcast,
    ...overrides,
  };
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleHooksRoutes(
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-hooks-routes-"));
  await fs.mkdir(path.join(home, "proj"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("GET /hooks", () => {
  it("returns the switch, the config, detected commands and recent events", async () => {
    await fs.writeFile(path.join(home, "proj", ".prettierrc"), "{}");
    const ctx = makeCtx();
    ctx.hooks.record({ hookId: "x", label: "x", tool: "edit", phase: "post", outcome: "ran" });
    const reply = await call(ctx, "/hooks", undefined, "GET");
    expect(reply).toEqual({
      status: 200,
      body: {
        enabled: false,
        config: defaultHooksConfig(),
        detected: { format: `npx prettier --write "${path.join("src", "index.ts")}"` },
        recent: [{ hookId: "x", label: "x", tool: "edit", phase: "post", outcome: "ran" }],
      },
    });
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "hook_event",
      expect.objectContaining({ hookId: "x" }),
    );
  });
});

describe("POST /hooks", () => {
  it("saves the switch to gg-app.json and the config to .gg/hooks.json, then broadcasts", async () => {
    const ctx = makeCtx();
    const reply = await call(ctx, "/hooks", {
      enabled: true,
      config: { presets: { blockDangerous: { enabled: true } }, custom: [] },
    });
    const expected = defaultHooksConfig();
    expected.presets.blockDangerous = { enabled: true };
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ enabled: true, config: expected });
    expect(await loadHooksEnabled(ctx.cwd)).toBe(true);
    expect(await loadHooksConfig(ctx.cwd)).toEqual(expected);
    expect(ctx.broadcast).toHaveBeenCalledWith("hooks_state", { enabled: true, config: expected });
    expect(ctx.hooks.runtime()).toBeDefined();
    // Only the switch: the config stays as it was.
    await call(ctx, "/hooks", { enabled: false });
    expect(await loadHooksEnabled(ctx.cwd)).toBe(false);
    expect(ctx.hooks.config).toEqual(expected);
    expect(ctx.hooks.runtime()).toBeUndefined();
  });

  it("rejects a malformed body", async () => {
    const ctx = makeCtx();
    expect((await call(ctx, "/hooks", { enabled: "yes" })).status).toBe(400);
    expect((await call(ctx, "/hooks", { config: [] })).status).toBe(400);
    expect((await call(ctx, "/hooks", 7)).status).toBe(400);
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });
});

describe("route scope", () => {
  it("is only for coding sessions with a controller", async () => {
    expect((await call(makeCtx({ goal: { dir: "x" } }), "/hooks", undefined, "GET")).status).toBe(
      404,
    );
    expect((await call(makeCtx({ mode: "chat" }), "/hooks", undefined, "GET")).status).toBe(404);
    expect((await call(makeCtx({ hooks: null }), "/hooks", { enabled: true })).status).toBe(404);
  });

  it("ignores other paths and methods", () => {
    const { res } = fakeResponse();
    const ctx = makeCtx() as unknown as SessionRouteContext;
    expect(handleHooksRoutes(ctx, {} as http.IncomingMessage, res, "/hooks/x", "GET")).toBe(false);
    expect(handleHooksRoutes(ctx, {} as http.IncomingMessage, res, "/hooks", "DELETE")).toBe(false);
  });
});

describe("hooks controller", () => {
  it("runs stop hooks and notifies on finish only when on", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 1, tail: "a\nb" }));
    const { controller, broadcast } = makeController({ enabled: true, runCommand });
    const config = defaultHooksConfig();
    config.presets.notifyOnFinish = { enabled: true };
    config.custom = [{ id: "done", event: "stop", command: "say done" }];
    controller.setConfig(config);
    await controller.afterUserRun("# Summary\n\nAll fixed.");
    expect(runCommand).toHaveBeenCalledWith("say done", 60_000, expect.any(AbortSignal));
    expect(broadcast).toHaveBeenCalledWith(
      "hook_event",
      expect.objectContaining({ hookId: "done", tool: "stop", outcome: "failed", detail: "a\nb" }),
    );
    expect(broadcast).toHaveBeenCalledWith("hook_notify", {
      title: "Israel Code",
      body: "proj — done: Summary",
    });
    expect(notifyBody("p", "")).toBe("p — done: run finished");
    // Off: nothing runs.
    controller.setEnabled(false);
    broadcast.mockClear();
    await controller.afterUserRun("x");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("keeps only the last 50 events", () => {
    const { controller } = makeController({});
    for (let i = 0; i < 60; i++) {
      controller.record({
        hookId: String(i),
        label: "",
        tool: "edit",
        phase: "post",
        outcome: "ran",
      });
    }
    const recent = controller.recent();
    expect(recent).toHaveLength(50);
    expect(recent[0]!.hookId).toBe("10");
  });
});
