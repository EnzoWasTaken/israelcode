import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: 0,
  body: undefined as unknown,
  reqBody: "{}",
  saved: [] as Array<Record<string, unknown>>,
  persistedThinking: [] as unknown[],
}));
vi.mock("./http.js", () => ({
  readBody: async () => h.reqBody,
  json: (_res: unknown, status: number, body: unknown) => {
    h.status = status;
    h.body = body;
  },
}));
vi.mock("./app-settings.js", () => ({
  ALL_PROVIDERS: [],
  saveProjectModelPrefs: async (_cwd: string, prefs: Record<string, unknown>) => {
    h.saved.push(prefs);
  },
  saveKenModelPref: async () => {},
  persistModelSelection: async () => {},
  persistThinkingLevel: async (_f: string, level: unknown) => {
    h.persistedThinking.push(level);
  },
}));
import type { SessionRouteContext } from "./route-context.js";
import { handleRunControlRoutes } from "./run-control-routes.js";

function makeCtx(autoEnabled: boolean) {
  const state = { provider: "anthropic", model: "claude-sonnet-5-5" };
  // Auto routed this run to "high"; the user's own effort is "low".
  let level: string | undefined = "high";
  const prewarm = vi.fn(async () => {});
  const abort = vi.fn();
  const ctx = {
    running: false,
    cwd: "/p",
    paths: { settingsFile: "s.json" },
    kenModelOverride: true,
    broadcast: vi.fn(),
    footerExtras: () => ({}),
    trophies: { count: async () => {} },
    sessionId: "s1",
    localModelBlocker: async () => null,
    autoRoute: {
      enabled: autoEnabled,
      pins: {},
      lastDecision: null,
      baseline: { provider: "anthropic", model: "claude-sonnet-5-5", thinkingLevel: "low" },
      routeAbort: { abort } as unknown as AbortController,
    },
    mode: "code",
    goal: null,
    session: {
      getState: () => state,
      getThinkingLevel: () => level,
      setThinkingLevel: (l: string | undefined) => {
        level = l;
      },
      switchModel: async (p: string, m: string) => {
        state.provider = p;
        state.model = m;
      },
      prewarm,
    },
  };
  return { ctx: ctx as unknown as SessionRouteContext, prewarm, abort, level: () => level };
}

async function call(ctx: SessionRouteContext, method: string, url: string, body?: unknown) {
  h.reqBody = JSON.stringify(body ?? {});
  expect(
    handleRunControlRoutes(ctx, {} as http.IncomingMessage, {} as http.ServerResponse, url, method),
  ).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  h.saved.length = 0;
  h.persistedThinking.length = 0;
});

describe("POST /model while Auto is on", () => {
  it("persists the user's baseline effort, not Auto's routed effort", async () => {
    const t = makeCtx(true);
    await call(t.ctx, "POST", "/model", { model: "claude-opus-5-5" });
    expect(h.saved[0]).toMatchObject({ model: "claude-opus-5-5", thinkingLevel: "low" });
    expect(h.persistedThinking).toEqual(["low"]);
    expect(t.level()).toBe("low");
  });

  it("prefers an explicitly pinned effort", async () => {
    const t = makeCtx(true);
    t.ctx.autoRoute.pins = { effort: "medium" };
    await call(t.ctx, "POST", "/model", { model: "claude-opus-5-5" });
    expect(h.saved[0]).toMatchObject({ thinkingLevel: "medium" });
  });

  it("leaves the session level alone when Auto is off", async () => {
    const t = makeCtx(false);
    await call(t.ctx, "POST", "/model", { model: "claude-opus-5-5" });
    expect(h.saved[0]).toMatchObject({ thinkingLevel: "high" });
  });
});

describe("POST /prewarm", () => {
  it("is skipped for Auto sessions", async () => {
    const t = makeCtx(true);
    await call(t.ctx, "POST", "/prewarm");
    expect(t.prewarm).not.toHaveBeenCalled();
    expect(h.body).toEqual({ accepted: false });
  });

  it("still warms a non-Auto session", async () => {
    const t = makeCtx(false);
    await call(t.ctx, "POST", "/prewarm");
    expect(t.prewarm).toHaveBeenCalledTimes(1);
    expect(h.body).toEqual({ accepted: true });
  });
});
