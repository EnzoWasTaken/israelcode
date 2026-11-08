/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies in route tests */
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
      running: false,
      runClaim: { active: false },
      session: {
        getState: () => ({ provider: "anthropic", model: "claude-opus-4-8" }),
        getThinkingLevel: () => undefined,
      },
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

describe("secrets and credentials (canary key)", () => {
  const CANARY = "canary-KEY-0123456789-SECRET";
  const decider = { kind: "decisions-api", service: "typesafe", model: "jev-latest" } as const;

  it("never puts the key in any response, diagnostics (memory or file) or provider-error text", async () => {
    const echo = (async () =>
      new Response(`bad key ${CANARY}`, { status: 401 })) as unknown as typeof fetch;
    const t = await setup({}, echo, { decider });
    await t.call("POST", "/routing/credential", { service: "typesafe", apiKey: CANARY });
    await t.call("GET", "/routing/config");
    await t.call("POST", "/routing/config", { config: { ...t.runtime.config(), enabled: true } });
    const test = await t.call("POST", "/routing/test");
    expect(test.body.error.message).toBe("The key was rejected (401)");
    await t.call("GET", "/routing/diagnostics");
    expect(t.bodies.join("\n")).not.toContain(CANARY);
    expect(JSON.stringify(await t.runtime.diagnostics.recent())).not.toContain(CANARY);
    const file = await fs
      .readFile(path.join(dir, "routing-diagnostics.jsonl"), "utf-8")
      .catch(() => "");
    expect(file).not.toContain(CANARY);
  });

  it("a model decider swallows a provider error that echoes the key", async () => {
    const { createLlmDecisionAdapter } = await import("../core/routing/index.js");
    const adapter = createLlmDecisionAdapter({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      credentials: { apiKey: CANARY },
      streamFn: () => ({
        response: Promise.reject(new Error(`401 invalid x-api-key ${CANARY}`)),
      }),
    });
    const err = await adapter
      .decide(
        {
          taskText: "t",
          signals: {} as never,
          currentModel: "m",
          candidates: [{ id: "a", description: "", thinkingLevels: [] } as never],
          allowedModes: ["standard"],
        } as never,
        new AbortController().signal,
      )
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain(CANARY);
    expect(JSON.stringify(err)).not.toContain(CANARY);
  });

  it("TypeSafe is not offered in the AI provider list", async () => {
    const { AUTH_PROVIDERS } = await import("../core/auth-providers.js");
    expect(AUTH_PROVIDERS.some((p) => p.value === ("typesafe" as never))).toBe(false);
  });
});

describe("decider credentials via sign-in", () => {
  it("offers sign-in (OAuth) providers as model deciders and builds an adapter from the resolved login", async () => {
    const t = await setup({}, undefined, {
      decider: { kind: "model", provider: "anthropic", model: "claude-haiku-5-5" },
    });
    (t.auth as any).isStaticApiKey = async () => false;
    (t.auth as any).resolveCredentials = async () => ({
      accessToken: "oauth-access-token",
      refreshToken: "r",
      expiresAt: 1,
    });
    const opts = await t.runtime.deciderOptions();
    const haiku = opts.find((o) => o.model === "claude-haiku-5-5");
    expect(haiku).toMatchObject({ available: true });
    expect(haiku?.note).toBeUndefined();
    const built = await t.runtime.buildAdapter();
    expect(built.adapter).not.toBeNull();
  });

  it("falls back to missing credentials when the login can't be refreshed", async () => {
    const t = await setup({}, undefined, {
      decider: { kind: "model", provider: "anthropic", model: "claude-haiku-5-5" },
    });
    (t.auth as any).resolveCredentials = async () => {
      throw new Error("refresh failed");
    };
    expect((await t.runtime.buildAdapter()).reason).toBe("missing_credentials");
  });
});

describe("plain-language problems", () => {
  it.each([
    ["missing_credentials", null, "No API key or sign-in"],
    ["missing_credentials", 401, "rejected"],
    ["provider_error", 402, "No credits"],
    ["rate_limited", 429, "Rate limited"],
    ["timeout", null, "too long"],
    ["invalid_output", null, "format"],
    ["constraint_violation", null, "No connected model"],
  ] as const)("%s / %s", (reason, status, text) => {
    expect(describeTestFailure(reason, status)).toContain(text);
  });

  it("GET /routing/config explains when nothing is connected", async () => {
    const t = await setup({}, undefined, {
      enabled: true,
      candidateModels: ["gpt-6-luna"],
    });
    const r = await t.call("GET", "/routing/config");
    expect(r.body.problems.join(" ")).toMatch(/No models are connected/);
  });
});

describe("session pins", () => {
  it("a manual pin touches only its own dimension and pins:null clears them", async () => {
    const events: unknown[] = [];
    const ctx = {
      mode: "code",
      goal: null,
      autoRoute: { enabled: true, pins: { effort: "high" }, lastDecision: null },
      broadcast: (t: string, d: unknown) => events.push([t, d]),
    } as unknown as SessionRouteContext;
    let out: any;
    const post = async (body: unknown) => {
      handleRoutingSessionRoute(
        ctx,
        {} as http.IncomingMessage,
        {} as http.ServerResponse,
        "/routing/session",
        "POST",
        async () => JSON.stringify(body),
        (_r, _s, b) => {
          out = b;
        },
      );
      await new Promise((r) => setTimeout(r, 20));
      return out;
    };
    const after = await post({ pins: { effort: "high", executionMode: "ultracode" } });
    expect(after.pins).toEqual({ effort: "high", executionMode: "ultracode" });
    expect(await post({ pins: null })).toMatchObject({ pins: {}, enabled: true });
    expect(events.at(-1)).toEqual(["route_state", expect.objectContaining({ pins: {} })]);
  });
});
