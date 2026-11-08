import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { getAllModels } from "../core/model-registry.js";
import {
  DEFAULT_AUTO_ROUTE_CONFIG,
  buildCapabilityRegistry,
  type DecisionAdapter,
  type RawRouteChoice,
} from "../core/routing/index.js";
import type { SessionRouteContext } from "./route-context.js";
import {
  AUTO_UNAVAILABLE_EXPLANATION,
  autoRoutePayload,
  classifyEscalation,
  routeUserPrompt,
  runProducedOutput,
  runWithEscalation,
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
}) {
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
      buildAdapter: async () => ({
        adapter: opts.adapter === undefined ? adapterPicking("haiku") : opts.adapter,
        lastStatus: () => null,
      }),
      cache: undefined,
      diagnostics: { record: vi.fn() },
    },
    session: {
      getMessages: () => messages,
      getState: () => state,
      getThinkingLevel: () => undefined,
      getContextUsage: () => ({ used: 100, size: 200000 }),
      switchModel,
      setThinkingLevel: vi.fn(),
      isUltracode: () => false,
      isOrchestrate: () => false,
      setUltracode: vi.fn(),
      setOrchestrate: vi.fn(),
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
