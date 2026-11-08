import { describe, expect, it } from "vitest";
import { nextEscalation } from "./escalation.js";
import { routeTask } from "./router.js";
import { makeConfig, makeRegistry, makeRequest, realModel, TEXT_ONLY } from "./routing-fixtures.js";

async function prevFor(req: ReturnType<typeof makeRequest>, registry = makeRegistry()) {
  return routeTask(req, { config: makeConfig(), registry, adapter: null });
}

describe("nextEscalation", () => {
  it("switches to another provider after a provider failure, bounded by maxAttempts", async () => {
    const req = makeRequest({ text: "explain this function" });
    const registry = makeRegistry();
    const prev = await prevFor(req);
    const deps = { config: makeConfig(), registry, request: req };
    const next = nextEscalation(prev, { kind: "rate_limited" }, 1, deps);
    expect(next).not.toBeNull();
    expect(next!.provider).not.toBe(prev.provider);
    expect(next!.explanation).toMatch(/^Switched to .+ after .+ was rate limited$/);
    expect(nextEscalation(prev, { kind: "rate_limited" }, 2, deps)).toBeNull();
    const off = { ...deps, config: makeConfig({ escalation: { enabled: true, maxAttempts: 0 } }) };
    expect(nextEscalation(prev, { kind: "rate_limited" }, 1, off)).toBeNull();
    const disabled = {
      ...deps,
      config: makeConfig({ escalation: { enabled: false, maxAttempts: 2 } }),
    };
    expect(nextEscalation(prev, { kind: "model_error" }, 1, disabled)).toBeNull();
  });

  it("excludes only the failed model for model_error", async () => {
    const req = makeRequest({ text: "explain this function" });
    const prev = await prevFor(req);
    const next = nextEscalation(prev, { kind: "model_error" }, 1, {
      config: makeConfig(),
      registry: makeRegistry(),
      request: req,
    });
    expect(next).not.toBeNull();
    expect(next!.model).not.toBe(prev.model);
  });

  it("never picks a non-vision model for an image task, and returns null when none is left", async () => {
    const registry = makeRegistry([realModel("claude-haiku-5-5"), TEXT_ONLY]);
    const req = makeRequest({ text: "look", attachments: [{ kind: "image" }] });
    const prev = await prevFor(req, registry);
    expect(prev.model).toBe("claude-haiku-5-5");
    expect(
      nextEscalation(prev, { kind: "provider_unavailable" }, 1, {
        config: makeConfig(),
        registry,
        request: req,
      }),
    ).toBeNull();
  });

  it("respects maxCostTier and never replaces a pinned model", async () => {
    const req = makeRequest({ text: "explain this function" });
    const registry = makeRegistry();
    const cfg = makeConfig({ maxCostTier: "low" });
    const prev = await routeTask(req, { config: cfg, registry, adapter: null });
    const next = nextEscalation(prev, { kind: "model_error" }, 1, {
      config: cfg,
      registry,
      request: req,
    });
    const picked = registry.find((c) => c.model === next?.model);
    if (picked) expect(picked.costTier).toBe("low");
    const pinned = makeRequest({
      text: "x",
      pins: { model: { provider: "anthropic", model: "claude-opus-5-5" } },
    });
    expect(
      nextEscalation({ ...prev, source: "pinned" }, { kind: "model_error" }, 1, {
        config: makeConfig(),
        registry,
        request: pinned,
      }),
    ).toBeNull();
  });

  it("moves to a larger context window on context_overflow", async () => {
    const req = makeRequest({ text: "explain this function" });
    const registry = makeRegistry([
      { ...realModel("claude-haiku-5-5"), contextWindow: 200_000 },
      { ...realModel("claude-sonnet-5-5"), contextWindow: 1_000_000 },
    ]);
    const prev = {
      ...(await prevFor(req, registry)),
      provider: "anthropic",
      model: "claude-haiku-5-5",
    };
    const next = nextEscalation(prev, { kind: "context_overflow" }, 1, {
      config: makeConfig(),
      registry,
      request: req,
    });
    expect(next?.model).toBe("claude-sonnet-5-5");
  });
});
