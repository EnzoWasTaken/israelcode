import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const routed = vi.hoisted(() => ({ run: vi.fn(async () => {}) }));
vi.mock("./session-routing.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("./session-routing.js")),
  runPromptWithRouting: routed.run,
}));
import type { SessionRouteContext } from "./route-context.js";
import { handlePromptRoutes } from "./prompt-routes.js";

let server: http.Server | undefined;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = undefined;
  routed.run.mockClear();
});

function makeCtx(running: boolean) {
  const events: Array<[string, unknown]> = [];
  const routing = { buildRegistry: vi.fn(), buildAdapter: vi.fn(), config: vi.fn() };
  const session = {
    queueMessage: vi.fn(() => 1),
    listQueuedMessages: () => [{ text: "again" }],
    prompt: vi.fn(async () => {}),
    switchModel: vi.fn(),
  };
  const ctx = {
    cwd: process.cwd(),
    sessionId: "s1",
    running,
    runClaim: { active: false, claim: () => true, release: () => {} },
    autopilotActive: false,
    startGoalFromMessage: async () => {},
    asks: { cancelAll: () => {} },
    runLifecycle: { running: false, isCancellationRequested: () => false, generation: 0 },
    trophies: { recordPrompt: async () => {}, count: async () => {} },
    broadcast: (t: string, d: unknown) => events.push([t, d]),
    autoRoute: { enabled: true, pins: {}, lastDecision: null },
    routing,
    session,
  };
  return { ctx: ctx as unknown as SessionRouteContext, events, routing, session };
}

async function post(ctx: SessionRouteContext, body: unknown) {
  server = http.createServer((req, res) => {
    handlePromptRoutes(ctx, req, res, "/prompt", "POST");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/prompt`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /prompt while a run is active", () => {
  it("queues the prompt as steering and never re-routes it", async () => {
    const t = makeCtx(true);
    const r = await post(t.ctx, { text: "also fix the tests", meta: { ultracode: true } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ queued: true });
    expect(t.session.queueMessage).toHaveBeenCalledWith("also fix the tests", []);
    expect(routed.run).not.toHaveBeenCalled();
    expect(t.routing.buildRegistry).not.toHaveBeenCalled();
    expect(t.routing.buildAdapter).not.toHaveBeenCalled();
    expect(t.session.switchModel).not.toHaveBeenCalled();
    expect(t.events.some(([type]) => type === "route_decision")).toBe(false);
    expect(t.events.some(([type]) => type === "queued")).toBe(true);
  });
});
