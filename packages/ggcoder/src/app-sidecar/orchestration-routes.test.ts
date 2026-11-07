import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir so the
// route's gg-app.json writes never touch the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { handleOrchestrationRoutes } = await import("./orchestration-routes.js");
const { loadOrchestrateDefault, loadWorkerModelPref } = await import("./app-settings.js");
const { resolveWorkerPick } = await import("./orchestration.js");

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

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  let orchestrate = false;
  const ctx = {
    mode: "code",
    goal: null,
    cwd: path.join(home, "proj"),
    workerModel: null as { provider: string; model: string } | null,
    session: {
      isOrchestrate: () => orchestrate,
      setOrchestrate: vi.fn((on: boolean) => {
        orchestrate = on;
      }),
    },
    auth: { hasProviderAuth: vi.fn(async (p: string) => p !== "xai") },
    broadcast: vi.fn(),
    ...overrides,
  };
  return ctx;
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleOrchestrationRoutes(
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-orch-routes-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("POST /orchestration/worker-model", () => {
  it("pins a known, connected, non-paid model, saves it per project and broadcasts", async () => {
    const ctx = makeCtx();
    const reply = await call(ctx, "/orchestration/worker-model", { model: "gpt-6-luna" });
    expect(reply).toEqual({ status: 200, body: { workerModel: "gpt-6-luna", orchestrate: false } });
    expect(ctx.workerModel).toEqual({ provider: "openai", model: "gpt-6-luna" });
    expect(ctx.broadcast).toHaveBeenCalledWith("orchestration_state", {
      workerModel: "gpt-6-luna",
      orchestrate: false,
    });
    expect(await loadWorkerModelPref(ctx.cwd)).toEqual({ provider: "openai", model: "gpt-6-luna" });
  });

  it("clears the pin with null so workers follow the orchestrator", async () => {
    const ctx = makeCtx({ workerModel: { provider: "openai", model: "gpt-6-luna" } });
    const reply = await call(ctx, "/orchestration/worker-model", { model: null });
    expect(reply.body).toEqual({ workerModel: null, orchestrate: false });
    expect(ctx.workerModel).toBeNull();
    expect(await loadWorkerModelPref(ctx.cwd)).toBeUndefined();
  });

  it("refuses an unknown model, a disconnected provider and a paid tier", async () => {
    const ctx = makeCtx();
    expect((await call(ctx, "/orchestration/worker-model", { model: "nope" })).status).toBe(404);
    const xai = (await call(ctx, "/orchestration/worker-model", { model: "grok-4.7" })).body as {
      error: string;
    };
    expect(xai.error).toMatch(/Connect xai first/);
    const paid = await call(ctx, "/orchestration/worker-model", { model: "claude-opus-5-5-fast" });
    expect(paid.status).toBe(400);
    expect((paid.body as { error: string }).error).toMatch(/spends real money/);
    expect(ctx.workerModel).toBeNull();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const ctx = makeCtx();
    const { res, reply } = fakeResponse();
    handleOrchestrationRoutes(
      ctx as unknown as SessionRouteContext,
      Readable.from([Buffer.from("{nope")]) as unknown as http.IncomingMessage,
      res,
      "/orchestration/worker-model",
      "POST",
    );
    expect((await reply).status).toBe(400);
  });
});

describe("POST /orchestration/toggle", () => {
  it("switches the live session and persists the default", async () => {
    const ctx = makeCtx();
    const on = await call(ctx, "/orchestration/toggle", { on: true });
    expect(on).toEqual({ status: 200, body: { workerModel: null, orchestrate: true } });
    expect(ctx.session.setOrchestrate).toHaveBeenCalledWith(true);
    expect(await loadOrchestrateDefault()).toBe(true);
    expect(ctx.broadcast).toHaveBeenCalledWith("orchestration_state", {
      workerModel: null,
      orchestrate: true,
    });
    const off = await call(ctx, "/orchestration/toggle", { on: false });
    expect((off.body as { orchestrate: boolean }).orchestrate).toBe(false);
    expect(await loadOrchestrateDefault()).toBe(false);
  });

  it("is only for coding sessions, not goals or chat", async () => {
    expect(
      (await call(makeCtx({ goal: { dir: "x" } }), "/orchestration/toggle", { on: true })).status,
    ).toBe(404);
    expect(
      (await call(makeCtx({ mode: "chat" }), "/orchestration/toggle", { on: true })).status,
    ).toBe(404);
  });

  it("ignores other paths and methods", () => {
    const { res } = fakeResponse();
    const ctx = makeCtx() as unknown as SessionRouteContext;
    expect(
      handleOrchestrationRoutes(ctx, {} as http.IncomingMessage, res, "/ultracode", "POST"),
    ).toBe(false);
    expect(
      handleOrchestrationRoutes(
        ctx,
        {} as http.IncomingMessage,
        res,
        "/orchestration/toggle",
        "GET",
      ),
    ).toBe(false);
  });
});

describe("resolveWorkerPick", () => {
  const auth = { hasProviderAuth: async (p: string) => p === "openai" };
  it("keeps a valid pin and drops a stale or disconnected one", async () => {
    expect(await resolveWorkerPick({ provider: "openai", model: "gpt-6-luna" }, auth)).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
    });
    expect(await resolveWorkerPick({ provider: "openai", model: "gone" }, auth)).toBeNull();
    expect(
      await resolveWorkerPick({ provider: "anthropic", model: "gpt-6-luna" }, auth),
    ).toBeNull();
    expect(await resolveWorkerPick({ provider: "xai", model: "grok-4.7" }, auth)).toBeNull();
    expect(await resolveWorkerPick(undefined, auth)).toBeNull();
  });
});
