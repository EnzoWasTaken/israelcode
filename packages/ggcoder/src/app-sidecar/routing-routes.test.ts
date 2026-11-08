import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTO_ROUTE_CONFIG, type AutoRouteConfig } from "../core/routing/index.js";
import type { SessionRouteContext } from "./route-context.js";
import {
  checkKeyShape,
  describeTestFailure,
  handleRoutingRoutes,
  handleRoutingSessionRoute,
} from "./routing-routes.js";
import { createRoutingRuntime, maskKey, DiagnosticsLog } from "./routing-runtime.js";

const RAW_TS = "ts-secret-ABCDEFGH1234";
const RAW_OR = "or-secret-ZYXWVUTS9876";

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-routing-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeAuth(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getCredentials: async (k: string) =>
      store.has(k) ? { accessToken: store.get(k)!, refreshToken: "", expiresAt: 1 } : undefined,
    setCredentials: async (k: string, c: { accessToken: string }) => {
      store.set(k, c.accessToken);
    },
    clearCredentials: async (k: string) => {
      store.delete(k);
    },
    hasProviderAuth: async (p: string) => p === "anthropic" || store.has(p),
    isStaticApiKey: async () => true,
    resolveCredentials: async () => ({ accessToken: "x", refreshToken: "", expiresAt: 1 }),
  };
}

async function setup(
  creds: Record<string, string> = {},
  fetchFn?: typeof fetch,
  cfg?: Partial<AutoRouteConfig>,
) {
  const auth = fakeAuth(creds);
  const saved: AutoRouteConfig[] = [];
  const runtime = await createRoutingRuntime({
    auth: auth as never,
    agentDir: dir,
    fetchFn,
    initialConfig: { ...DEFAULT_AUTO_ROUTE_CONFIG, ...cfg },
    persist: async (c) => {
      saved.push(c);
    },
  });
  const bodies: string[] = [];
  async function call(method: string, url: string, body?: unknown) {
    let status = 0;
    let out: unknown;
    const handled = handleRoutingRoutes(
      {
        runtime,
        auth: auth as never,
        readBody: async () => JSON.stringify(body ?? {}),
        json: (_res, s, b) => {
          status = s;
          out = b;
          bodies.push(JSON.stringify(b));
        },
      },
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      url,
      method,
    );
    expect(handled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    return { status, body: out as Record<string, any> };
  }
  return { auth, runtime, saved, call, bodies };
}

describe("masking and key checks", () => {
  it("masks all but the last four", () => {
    expect(maskKey(RAW_TS)).toBe("••••1234");
    expect(checkKeyShape("short")).not.toBeNull();
    expect(checkKeyShape("has space inside")).not.toBeNull();
    expect(checkKeyShape(RAW_TS)).toBeNull();
  });
});

describe("GET /routing/config", () => {
  it("returns defaults with masked credentials and decider options", async () => {
    const t = await setup({ typesafe: RAW_TS });
    const r = await t.call("GET", "/routing/config");
    expect(r.status).toBe(200);
    expect(r.body.config.enabled).toBe(false);
    expect(r.body.credentials.typesafe).toEqual({ set: true, masked: "••••1234" });
    expect(r.body.credentials.openrouter).toEqual({ set: false, masked: null });
    const jev = r.body.deciderOptions.find((o: any) => o.service === "typesafe");
    expect(jev.available).toBe(true);
    expect(r.body.deciderOptions.find((o: any) => o.service === "openrouter").available).toBe(
      false,
    );
    expect(t.bodies.join()).not.toContain(RAW_TS);
  });
});

describe("POST /routing/config", () => {
  it("rejects invalid configs with readable problems", async () => {
    const t = await setup();
    const r = await t.call("POST", "/routing/config", {
      config: { enabled: "yes", decider: { kind: "bogus" }, candidateModels: ["no-such-model"] },
    });
    expect(r.status).toBe(400);
    expect(r.body.problems.length).toBeGreaterThanOrEqual(3);
    expect(t.saved).toHaveLength(0);
  });

  it("saves a valid config and notifies listeners", async () => {
    const t = await setup({ typesafe: RAW_TS });
    let pushed: AutoRouteConfig | null = null;
    t.runtime.onConfigChange((c) => (pushed = c));
    const r = await t.call("POST", "/routing/config", {
      config: {
        enabled: true,
        decider: { kind: "decisions-api", service: "typesafe", model: "jev-latest" },
      },
    });
    expect(r.status).toBe(200);
    expect(t.saved[0]?.enabled).toBe(true);
    expect(pushed).not.toBeNull();
    expect(r.body.problems).toEqual([]);
  });
});

describe("credentials", () => {
  it("stores a TypeSafe key and only returns the mask", async () => {
    const t = await setup();
    expect(
      (await t.call("POST", "/routing/credential", { service: "typesafe", apiKey: "bad key" }))
        .status,
    ).toBe(400);
    const r = await t.call("POST", "/routing/credential", {
      service: "typesafe",
      apiKey: `  ${RAW_TS} `,
    });
    expect(r.status).toBe(200);
    expect(r.body.masked).toBe("••••1234");
    expect(t.auth.store.get("typesafe")).toBe(RAW_TS);
    expect(t.bodies.join()).not.toContain(RAW_TS);
    const del = await t.call("DELETE", "/routing/credential/typesafe");
    expect(del.status).toBe(200);
    expect(t.auth.store.has("typesafe")).toBe(false);
  });

  it("does not overwrite an existing OpenRouter key without replace", async () => {
    const t = await setup({ openrouter: RAW_OR });
    const r = await t.call("POST", "/routing/credential", {
      service: "openrouter",
      apiKey: "new-key-1234567",
    });
    expect(r.status).toBe(409);
    expect(t.auth.store.get("openrouter")).toBe(RAW_OR);
    expect(t.bodies.join()).not.toContain(RAW_OR);
    const ok = await t.call("POST", "/routing/credential", {
      service: "openrouter",
      apiKey: "new-key-1234567",
      replace: true,
    });
    expect(ok.status).toBe(200);
    expect(t.auth.store.get("openrouter")).toBe("new-key-1234567");
  });
});

describe("POST /routing/test", () => {
  const decider = { kind: "decisions-api", service: "typesafe", model: "jev-latest" } as const;

  it.each([
    [401, "The key was rejected (401)"],
    [402, "No credits on the account (402)"],
    [429, "Rate limited, try again shortly"],
  ])("maps HTTP %i to a plain message without leaking the key or body", async (status, message) => {
    const fetchFn = (async () =>
      new Response(`provider body mentioning ${RAW_TS}`, { status })) as typeof fetch;
    const t = await setup({ typesafe: RAW_TS }, fetchFn, { decider });
    const r = await t.call("POST", "/routing/test");
    expect(r.body.ok).toBe(false);
    expect(r.body.error.message).toBe(message);
    expect(t.bodies.join()).not.toContain(RAW_TS);
    expect(t.bodies.join()).not.toContain("provider body");
  });

  it("reports success with a sample", async () => {
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      const first = Object.keys(req.questions.model.criteria)[0];
      const answers: Record<string, unknown> = {
        model: { type: "choice", choice: first, confidence: 0.9 },
        difficulty: { type: "score", score: 1, confidence: 0.9 },
        task_kind: { type: "choice", choice: "coding", confidence: 0.9 },
      };
      if (req.questions.mode)
        answers.mode = { type: "choice", choice: "standard", confidence: 0.9 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = await setup({ typesafe: RAW_TS }, fetchFn, { decider });
    const r = await t.call("POST", "/routing/test");
    expect(r.body.ok).toBe(true);
    expect(r.body.sample.model).toBeTruthy();
  });

  it("explains a missing key", async () => {
    const t = await setup({}, undefined, { decider });
    const r = await t.call("POST", "/routing/test");
    expect(r.body.ok).toBe(false);
    expect(r.body.error.reason).toBe("missing_credentials");
  });
  it("describes failures", () => {
    expect(describeTestFailure("provider_error", 503)).toContain("503");
  });
});

describe("diagnostics", () => {
  it("keeps the last 50, caps the file, and holds no task text", async () => {
    const file = path.join(dir, "d.jsonl");
    const log = new DiagnosticsLog(file, 10);
    for (let i = 0; i < 620; i++) {
      log.record({
        timestamp: i,
        sessionHash: "h",
        provider: "p",
        model: "m",
        effort: null,
        executionMode: "standard",
        source: "router",
        reason: "coding",
        taskKind: "coding",
        difficulty: "simple",
        confidence: 1,
        latencyMs: 1,
        workspace: "code",
        attachmentKinds: [],
        textLength: 5,
        textHash: "abc",
      });
    }
    const recent = await log.recent(50);
    expect(recent).toHaveLength(50);
    expect(recent.at(-1)?.timestamp).toBe(619);
    const lines = (await fs.readFile(file, "utf-8")).split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(520);
  });
});

describe("POST /routing/session", () => {
  function sessionCtx() {
    const events: unknown[] = [];
    const ctx = {
      mode: "code",
      goal: null,
      autoRoute: { enabled: false, pins: {}, lastDecision: null },
      broadcast: (t: string, d: unknown) => events.push([t, d]),
    } as unknown as SessionRouteContext;
    return { ctx, events };
  }
  async function post(ctx: SessionRouteContext, body: unknown) {
    let status = 0;
    let out: any;
    handleRoutingSessionRoute(
      ctx,
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      "/routing/session",
      "POST",
      async () => JSON.stringify(body),
      (_r, s, b) => {
        status = s;
        out = b;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    return { status, body: out };
  }

  it("enables, pins and broadcasts route_state", async () => {
    const { ctx, events } = sessionCtx();
    const r = await post(ctx, { enabled: true, pins: { effort: "high" } });
    expect(r.status).toBe(200);
    expect(ctx.autoRoute.enabled).toBe(true);
    expect(ctx.autoRoute.pins).toEqual({ effort: "high" });
    expect(events).toHaveLength(1);
    expect((await post(ctx, { pins: null })).body.pins).toEqual({});
  });

  it("rejects pins that reference an unknown model", async () => {
    const { ctx } = sessionCtx();
    const r = await post(ctx, { pins: { model: { provider: "anthropic", model: "nope-9" } } });
    expect(r.status).toBe(400);
    expect(ctx.autoRoute.pins).toEqual({});
  });

  it("reports unavailable for goal windows", async () => {
    const { ctx } = sessionCtx();
    (ctx as any).goal = { dir: "x" };
    expect((await post(ctx, { enabled: true })).status).toBe(409);
  });
});
