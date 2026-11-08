import { beforeEach, describe, expect, it, vi } from "vitest";

const defaults = vi.hoisted(() => ({ ultracode: false, orchestrate: false }));
vi.mock("./app-settings.js", () => ({
  loadUltracodeDefault: async () => defaults.ultracode,
  loadOrchestrateDefault: async () => defaults.orchestrate,
}));
import type { Message } from "@kenkaiiii/gg-ai";
import { getAllModels } from "../core/model-registry.js";
import {
  DEFAULT_AUTO_ROUTE_CONFIG,
  RouteCache,
  buildCapabilityRegistry,
  type DecisionAdapter,
  type RawRouteChoice,
} from "../core/routing/index.js";
import type { SessionRouteContext } from "./route-context.js";
import {
  AUTO_UNAVAILABLE_EXPLANATION,
  autoRoutePayload,
  classifyEscalation,
  restoreRunModes,
  routeUserPrompt,
  runProducedOutput,
  runPromptWithRouting,
  setAutoEnabled,
  runWithEscalation,
  followSavedAutoDefault,
} from "./session-routing.js";

const registry = buildCapabilityRegistry({
  models: getAllModels().filter((m) => m.provider !== "local"),
  isAvailable: (p) => p === "anthropic" || p === "openai",
});

function adapterPicking(match: string): DecisionAdapter {
  return {
    id: "stub",
    label: "stub",
    async decide(input): Promise<RawRouteChoice> {
      const pick = input.candidates.find((c) => c.id.includes(match)) ?? input.candidates[0]!;
      return {
        model: pick.id,
        effort: null,
        executionMode: "standard",
        taskKind: "coding",
        difficulty: "simple",
        confidence: 0.95,
      };
    },
  };
}

function makeCtx(opts: {
  enabled?: boolean;
  adapter?: DecisionAdapter | null;
  throwing?: boolean;
  pins?: SessionRouteContext["autoRoute"]["pins"];
  mode?: "code" | "chat" | "motion";
  thinking?: "low" | "high";
  slash?: boolean;
  buildAdapter?: () => Promise<unknown>;
}) {
  const flags = { ultracode: false, orchestrate: false, thinking: opts.thinking };
  const state = { provider: "openai", model: "gpt-6-luna" };
  const messages: Message[] = [];
  const events: Array<[string, unknown]> = [];
  const markers: Array<[string, unknown]> = [];
  const switchModel = vi.fn(async (provider: string, model: string) => {
    state.provider = provider;
    state.model = model;
  });
  const ctx = {
    mode: opts.mode ?? "code",
    goal: null,
    running: false,
    runClaim: { active: false },
    kenStatePayload: () => ({}),
    sessionId: "s1",
    kenModelOverride: null,
    syncKenModel: vi.fn(async () => {}),
    syncKenAutoModel: vi.fn(async () => {}),
    footerExtras: () => ({}),
    broadcast: (t: string, d: unknown) => events.push([t, d]),
    autoRoute: { enabled: opts.enabled ?? true, pins: opts.pins ?? {}, lastDecision: null },
    routing: {
      config: () => ({ ...DEFAULT_AUTO_ROUTE_CONFIG, enabled: true }),
      buildRegistry: async () => {
        if (opts.throwing) throw new Error("boom");
        return registry;
      },
      secrets: async () => [],
      buildAdapter:
        opts.buildAdapter ??
        (async () => ({
          adapter: opts.adapter === undefined ? adapterPicking("haiku") : opts.adapter,
          lastStatus: () => null,
        })),
      cache: undefined,
      diagnostics: { record: vi.fn() },
    },
    session: {
      willExpandPromptTemplate: async () => opts.slash === true,
      getMessages: () => messages,
      getState: () => state,
      getThinkingLevel: () => flags.thinking,
      getContextUsage: () => ({ used: 100, size: 200000 }),
      switchModel,
      setThinkingLevel: vi.fn((l: "low" | "high" | undefined) => {
        flags.thinking = l;
      }),
      isUltracode: () => flags.ultracode,
      isOrchestrate: () => flags.orchestrate,
      setUltracode: vi.fn((v: boolean) => {
        flags.ultracode = v;
      }),
      setOrchestrate: vi.fn((v: boolean) => {
        flags.orchestrate = v;
      }),
      persistAppMarker: vi.fn(async (k: string, d: unknown) => {
        markers.push([k, d]);
      }),
    },
  };
  return {
    ctx: ctx as unknown as SessionRouteContext,
    switchModel,
    events,
    markers,
    messages,
    flags,
    raw: ctx,
  };
}

describe("routeUserPrompt", () => {
  it("leaves everything alone when Auto is off", async () => {
    const t = makeCtx({ enabled: false });
    expect(await routeUserPrompt(t.ctx, { text: "hi", attachments: [] })).toBeNull();
    expect(t.switchModel).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it("is unavailable in motion workspaces", async () => {
    const t = makeCtx({ mode: "motion" });
    expect(await routeUserPrompt(t.ctx, { text: "hi", attachments: [] })).toBeNull();
    expect(autoRoutePayload(t.ctx)).toMatchObject({ available: false, enabled: false });
  });

  it("applies the decision, broadcasts it first and stores a marker", async () => {
    const t = makeCtx({});
    const run = await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    expect(run?.decision.source).toBe("router");
    expect(t.switchModel).toHaveBeenCalledTimes(1);
    expect(t.switchModel.mock.calls[0]![1]).toContain("haiku");
    const ev = t.events.find(([type]) => type === "route_decision");
    expect(ev?.[1]).toMatchObject({ source: "router", fallbackReason: null });
    expect(t.markers[0]?.[0]).toBe("route_decision");
    expect(t.ctx.autoRoute.lastDecision?.model).toContain("haiku");
  });

  it("lets a model pin win", async () => {
    const t = makeCtx({ pins: { model: { provider: "openai", model: "gpt-6-luna" } } });
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    expect(t.switchModel).not.toHaveBeenCalled();
  });

  it("shows a fallback when routing throws and never blocks", async () => {
    const t = makeCtx({ throwing: true });
    expect(await routeUserPrompt(t.ctx, { text: "x", attachments: [] })).toBeNull();
    const ev = t.events.find(([type]) => type === "route_decision");
    expect(ev?.[1]).toMatchObject({
      explanation: AUTO_UNAVAILABLE_EXPLANATION,
      fallbackReason: "provider_error",
    });
    expect(t.switchModel).not.toHaveBeenCalled();
  });

  it("never moves an image prompt to a non-vision model", async () => {
    const t = makeCtx({});
    await routeUserPrompt(t.ctx, {
      text: "what is in this",
      attachments: [{ kind: "image", name: "a.png", mediaType: "image/png", data: "" }],
    });
    for (const call of t.switchModel.mock.calls) {
      const cap = registry.find((c) => c.model === call[1]);
      expect(cap?.vision).toBe(true);
    }
  });
});

describe("escalation guard", () => {
  const assistantWithTool: Message = {
    role: "assistant",
    content: [{ type: "tool_call", id: "1", name: "bash", args: {} }],
  } as Message;

  it("classifies only retryable provider failures", () => {
    expect(classifyEscalation(new Error("model_not_found"))).toEqual({ kind: "model_error" });
    expect(classifyEscalation(new Error("invalid api key"))).toBeNull();
    expect(classifyEscalation(new Error("something else"))).toBeNull();
  });

  it("detects produced output", () => {
    expect(runProducedOutput([{ role: "user", content: "hi" }], 0)).toBe(false);
    expect(runProducedOutput([assistantWithTool], 0)).toBe(true);
    expect(runProducedOutput([assistantWithTool], 1)).toBe(false);
  });

  it("retries once on the escalated model when nothing was produced", async () => {
    const t = makeCtx({});
    const routed = await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    const retry = vi.fn(async () => {});
    await runWithEscalation(
      t.ctx,
      routed,
      async () => {
        t.messages.push({ role: "user", content: "rename a variable" });
        throw new Error("model_not_found");
      },
      retry,
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(t.events.filter(([type]) => type === "route_decision")).toHaveLength(2);
  });

  it("does not retry (no duplicate tool calls) once output exists", async () => {
    const t = makeCtx({});
    const routed = await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    const retry = vi.fn(async () => {});
    await expect(
      runWithEscalation(
        t.ctx,
        routed,
        async () => {
          t.messages.push(assistantWithTool);
          throw new Error("model_not_found");
        },
        retry,
      ),
    ).rejects.toThrow("model_not_found");
    expect(retry).not.toHaveBeenCalled();
  });

  it("surfaces the error when Auto did not route", async () => {
    const t = makeCtx({});
    const retry = vi.fn(async () => {});
    await expect(
      runWithEscalation(
        t.ctx,
        null,
        async () => {
          throw new Error("model_not_found");
        },
        retry,
      ),
    ).rejects.toThrow();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("escalation retry shape", () => {
  const down = () => new Error("model_not_found");

  it("re-sends the original prompt when the failure came before the message was recorded", async () => {
    const t = makeCtx({});
    const routed = await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    const retry = vi.fn(async () => {});
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw down(); // nothing recorded in the transcript
      t.messages.push({ role: "user", content: "rename a variable" });
    });
    await runWithEscalation(t.ctx, routed, attempt, retry);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });

  it("bounds the number of escalation attempts", async () => {
    const t = makeCtx({});
    const routed = await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    const max = routed!.config.escalation.maxAttempts;
    const retry = vi.fn(async () => {
      throw down();
    });
    await expect(
      runWithEscalation(
        t.ctx,
        routed,
        async () => {
          t.messages.push({ role: "user", content: "rename a variable" });
          throw down();
        },
        retry,
      ),
    ).rejects.toThrow("model_not_found");
    expect(retry.mock.calls.length).toBeLessThanOrEqual(max);
  });

  it("never retries an auth failure", async () => {
    const t = makeCtx({});
    const routed = await routeUserPrompt(t.ctx, { text: "x", attachments: [] });
    const retry = vi.fn(async () => {});
    await expect(
      runWithEscalation(
        t.ctx,
        routed,
        async () => {
          throw new Error("invalid api key");
        },
        retry,
      ),
    ).rejects.toThrow();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("runPromptWithRouting (the prompt hook)", () => {
  beforeEach(() => {
    defaults.ultracode = false;
    defaults.orchestrate = false;
  });
  const flagsOf = () => ({ ultracode: false, orchestrate: false });
  const run = (
    t: ReturnType<typeof makeCtx>,
    text: string,
    meta: Parameters<typeof runPromptWithRouting>[1]["meta"],
    send = vi.fn(async () => {}),
  ) => {
    const flags = flagsOf();
    return {
      send,
      flags,
      done: runPromptWithRouting(
        t.ctx,
        { text, attachments: [], meta, send, retry: async () => {} },
        flags,
      ),
    };
  };

  it("runs the prompt on the current model and broadcasts a fallback when routing fails", async () => {
    const t = makeCtx({ throwing: true });
    const r = run(t, "hello", undefined);
    await r.done;
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(t.switchModel).not.toHaveBeenCalled();
    const ev = t.events.find(([type]) => type === "route_decision");
    expect(ev?.[1]).toMatchObject({ source: "fallback", fallbackReason: "provider_error" });
  });

  it("does not route scheduled or plan-revision prompts", async () => {
    for (const meta of [{ scheduled: true }, { planRevision: true }]) {
      const t = makeCtx({});
      const r = run(t, "tick", meta);
      await r.done;
      expect(r.send).toHaveBeenCalledTimes(1);
      expect(t.switchModel).not.toHaveBeenCalled();
      expect(t.events.some(([type]) => type === "route_decision")).toBe(false);
    }
  });

  it("a typed ultracode keyword pins the mode and is undone after the run", async () => {
    const t = makeCtx({});
    const r = run(t, "ultracode fix the bug", { ultracode: true });
    await r.done;
    expect(t.flags.ultracode).toBe(true);
    expect(r.flags.ultracode).toBe(true);
    await restoreRunModes(t.ctx, r.flags);
    expect(t.flags.ultracode).toBe(false);
  });

  it("a typed orchestrate keyword pins orchestrate mode", async () => {
    const t = makeCtx({});
    const r = run(t, "orchestrate the migration", { orchestrate: true });
    await r.done;
    expect(t.flags.orchestrate).toBe(true);
    await restoreRunModes(t.ctx, r.flags);
    expect(t.flags.orchestrate).toBe(false);
  });

  it("restores to the user's own saved toggle, not blindly off", async () => {
    const t = makeCtx({});
    const r = run(t, "ultracode go", { ultracode: true });
    await r.done;
    defaults.ultracode = true; // the user switched Ultracode on while it ran
    await restoreRunModes(t.ctx, r.flags);
    expect(t.flags.ultracode).toBe(true);
  });

  it("leaves a user's own already-on Ultracode untouched", async () => {
    const t = makeCtx({});
    t.flags.ultracode = true;
    const r = run(t, "ultracode go", { ultracode: true });
    await r.done;
    expect(r.flags.ultracode).toBe(false);
    await restoreRunModes(t.ctx, r.flags);
    expect(t.raw.session.setUltracode).not.toHaveBeenCalledWith(false);
  });
});

describe("baseline restore when Auto is turned off", () => {
  it("switches back to the user's model and thinking and broadcasts both", async () => {
    const t = makeCtx({ thinking: "high" });
    await setAutoEnabled(t.ctx, true);
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    expect(t.switchModel.mock.calls[0]![1]).toContain("haiku");
    t.events.length = 0;
    await setAutoEnabled(t.ctx, false);
    expect(t.switchModel).toHaveBeenLastCalledWith("openai", "gpt-6-luna", { confirmPaid: true });
    expect(t.flags.thinking).toBe("high");
    expect(t.events.map(([k]) => k)).toEqual(
      expect.arrayContaining(["thinking_change", "extras", "ken_model_change"]),
    );
    expect(t.ctx.autoRoute.baseline).toBeUndefined();
  });

  it("restores the latest explicit pick, not the first model", async () => {
    const t = makeCtx({});
    await setAutoEnabled(t.ctx, true);
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    t.ctx.autoRoute.baseline = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      thinkingLevel: undefined,
    };
    await setAutoEnabled(t.ctx, false);
    expect(t.switchModel).toHaveBeenLastCalledWith("anthropic", "claude-opus-4-8", {
      confirmPaid: true,
    });
  });

  it("defers the restore until the run ends when Auto is turned off mid-run", async () => {
    const t = makeCtx({});
    await setAutoEnabled(t.ctx, true);
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    const calls = t.switchModel.mock.calls.length;
    t.raw.running = true;
    await setAutoEnabled(t.ctx, false);
    expect(t.switchModel.mock.calls.length).toBe(calls);
    t.raw.running = false;
    await restoreRunModes(t.ctx, { ultracode: false, orchestrate: false });
    expect(t.switchModel).toHaveBeenLastCalledWith("openai", "gpt-6-luna", { confirmPaid: true });
  });

  it("routing code never touches the preference stores", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./session-routing.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/saveProjectModelPrefs|persistModelSelection|persistThinkingLevel/);
  });
});

describe("saved Auto default vs live windows", () => {
  it("does not turn Auto back on in a window the user switched off", async () => {
    const t = makeCtx({ enabled: true });
    t.raw.autoRoute = { ...t.raw.autoRoute, savedEnabled: false } as never;
    await setAutoEnabled(t.ctx, false, { byUser: true });
    expect(await followSavedAutoDefault(t.ctx, true)).toBe(false);
    expect(t.ctx.autoRoute.enabled).toBe(false);
  });

  it("follows a real change for a never-toggled window, but not an unchanged save", async () => {
    const t = makeCtx({ enabled: false });
    (t.ctx.autoRoute as { savedEnabled?: boolean }).savedEnabled = false;
    expect(await followSavedAutoDefault(t.ctx, false)).toBe(false);
    expect(await followSavedAutoDefault(t.ctx, true)).toBe(true);
    expect(t.ctx.autoRoute.enabled).toBe(true);
    // An unrelated settings edit re-saves the same value.
    t.ctx.autoRoute.enabled = false;
    expect(await followSavedAutoDefault(t.ctx, true)).toBe(false);
    expect(t.ctx.autoRoute.enabled).toBe(false);
  });
});

describe("routing latency and cancellation", () => {
  it("does not build the adapter on a route-cache hit", async () => {
    const buildAdapter = vi.fn(async () => ({
      adapter: adapterPicking("luna"),
      lastStatus: () => null,
    }));
    const t = makeCtx({ buildAdapter });
    (t.raw.routing as { cache: unknown }).cache = new RouteCache();
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    expect(buildAdapter).toHaveBeenCalledTimes(1);
    await routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    expect(buildAdapter).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending decision when Stop fires, and still runs the prompt", async () => {
    const slow: DecisionAdapter = {
      id: "slow",
      label: "slow",
      decide: () => new Promise(() => {}),
    };
    const t = makeCtx({ adapter: slow });
    const p = routeUserPrompt(t.ctx, { text: "rename a variable", attachments: [] });
    await vi.waitFor(() => expect(t.ctx.autoRoute.routeAbort).toBeDefined());
    t.ctx.autoRoute.routeAbort!.abort();
    const run = await p;
    expect(run?.decision.source).toBe("fallback");
    expect(t.ctx.autoRoute.routeAbort).toBeUndefined();
  });

  it("does not route a slash-command template", async () => {
    const t = makeCtx({ slash: true });
    const send = vi.fn(async () => {});
    await runPromptWithRouting(
      t.ctx,
      { text: "/review", attachments: [], meta: undefined, send, retry: send },
      { ultracode: false, orchestrate: false },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.switchModel).not.toHaveBeenCalled();
    expect(t.ctx.autoRoute.lastDecision).toBeNull();
  });
});
