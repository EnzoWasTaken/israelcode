import { describe, expect, it, vi } from "vitest";
import { RouteCache } from "./cache.js";
import { DecisionError, type DecisionAdapter, type RawRouteChoice } from "./decision-adapter.js";
import type { RouteDiagnostic } from "./diagnostics.js";
import { routeTask } from "./router.js";
import { makeConfig, makeRegistry, makeRequest, realModel, TEXT_ONLY } from "./routing-fixtures.js";

const choice = (over: Partial<RawRouteChoice> = {}): RawRouteChoice => ({
  model: "anthropic:claude-haiku-5-5",
  effort: "low",
  executionMode: "standard",
  taskKind: "conversation",
  difficulty: "simple",
  confidence: 0.9,
  ...over,
});
const adapterOf = (fn: DecisionAdapter["decide"]): DecisionAdapter & { calls: number } => {
  const a = {
    id: "t",
    label: "test-decider",
    calls: 0,
    decide: (i: Parameters<DecisionAdapter["decide"]>[0], s: AbortSignal) => {
      a.calls++;
      return fn(i, s);
    },
  };
  return a;
};
const deps = (adapter: DecisionAdapter | null, over = {}) => ({
  config: makeConfig(),
  registry: makeRegistry(),
  adapter,
  ...over,
});

describe("routeTask", () => {
  it("uses the adapter's validated choice", async () => {
    const d = await routeTask(
      makeRequest({ text: "what is a monad" }),
      deps(adapterOf(async () => choice())),
    );
    expect(d).toMatchObject({
      source: "router",
      model: "claude-haiku-5-5",
      effort: "low",
      decisionModel: "test-decider",
    });
  });

  it("is a no-op when disabled", async () => {
    const d = await routeTask(
      makeRequest({ text: "hi" }),
      deps(null, { config: makeConfig({ enabled: false }) }),
    );
    expect(d).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbackReason: "disabled",
      source: "fallback",
    });
  });

  it.each([
    ["invalid output", async () => ({ nonsense: true }) as never, "invalid_output"],
    ["unknown model", async () => choice({ model: "nope" }), "invalid_output"],
    ["low confidence", async () => choice({ confidence: 0.2 }), "low_confidence"],
    [
      "401",
      async () => {
        throw new DecisionError("missing_credentials");
      },
      "missing_credentials",
    ],
    [
      "429",
      async () => {
        throw new DecisionError("rate_limited");
      },
      "rate_limited",
    ],
    [
      "crash",
      async () => {
        throw new Error("boom");
      },
      "provider_error",
    ],
  ])("falls back on %s", async (_n, fn, reason) => {
    const d = await routeTask(makeRequest({ text: "explain this" }), deps(adapterOf(fn as never)));
    expect(d.source).toBe("fallback");
    expect(d.fallbackReason).toBe(reason);
  });

  it("falls back with timeout even if the adapter ignores abort", async () => {
    const d = await routeTask(
      makeRequest({ text: "explain this" }),
      deps(
        adapterOf(() => new Promise(() => {})),
        { timeoutMs: 20 },
      ),
    );
    expect(d.fallbackReason).toBe("timeout");
  });

  it("falls back with no adapter", async () => {
    const d = await routeTask(makeRequest({ text: "hi" }), deps(null));
    expect(d.fallbackReason).toBe("no_decision_provider");
  });

  it("clamps effort to the model's supported levels", async () => {
    const d = await routeTask(
      makeRequest({ text: "x" }),
      deps(adapterOf(async () => choice({ model: "claude-haiku-5-5", effort: "ultra" }))),
    );
    expect(["max", "xhigh", "high"]).toContain(d.effort);
  });

  it("never routes images to a non-vision model", async () => {
    const registry = makeRegistry([realModel("claude-haiku-5-5"), TEXT_ONLY]);
    const req = makeRequest({ text: "what is wrong here", attachments: [{ kind: "image" }] });
    const d = await routeTask(
      req,
      deps(
        adapterOf(async () => choice({ model: "deepseek:textonly-coder" })),
        { registry },
      ),
    );
    expect(d.model).toBe("claude-haiku-5-5");
  });

  it("reports constraint_violation when no vision model is connected", async () => {
    const registry = makeRegistry([TEXT_ONLY]);
    const adapter = adapterOf(async () => choice());
    const d = await routeTask(
      makeRequest({ text: "see screenshot", attachments: [{ kind: "image" }] }),
      deps(adapter, { registry }),
    );
    expect(d).toMatchObject({ model: "claude-sonnet-5-5", fallbackReason: "constraint_violation" });
    expect(d.explanation).toContain("image");
    expect(adapter.calls).toBe(0);
  });

  it("refuses modes outside code sessions", async () => {
    for (const over of [
      { workspace: "chat" as const },
      { isGoal: true },
      { hasSpawnAgent: false },
    ]) {
      const d = await routeTask(
        makeRequest({ text: "x", ...over }),
        deps(adapterOf(async () => choice({ executionMode: "ultracode" }))),
      );
      expect(d.executionMode).toBe("standard");
    }
  });

  describe("pins", () => {
    it("override each dimension independently", async () => {
      const a = adapterOf(async () => choice({ executionMode: "ultracode" }));
      const d = await routeTask(
        makeRequest({
          text: "x",
          pins: { model: { provider: "anthropic", model: "claude-opus-5-5" } },
        }),
        deps(a),
      );
      expect(d.model).toBe("claude-opus-5-5");
      expect(d.executionMode).toBe("ultracode");
      const e = await routeTask(makeRequest({ text: "x", pins: { effort: "high" } }), deps(a));
      expect(e).toMatchObject({ effort: "high", model: "claude-haiku-5-5" });
      const m = await routeTask(
        makeRequest({ text: "x", pins: { executionMode: "standard" } }),
        deps(a),
      );
      expect(m.executionMode).toBe("standard");
    });

    it("fully pinned skips the adapter", async () => {
      const a = adapterOf(async () => choice());
      const d = await routeTask(
        makeRequest({
          text: "x",
          pins: {
            model: { provider: "anthropic", model: "claude-opus-5-5" },
            effort: "max",
            executionMode: "standard",
          },
        }),
        deps(a),
      );
      expect(d).toMatchObject({ source: "pinned", model: "claude-opus-5-5", effort: "max" });
      expect(a.calls).toBe(0);
    });

    it("keeps an invalid pin with a warning", async () => {
      const registry = makeRegistry([realModel("claude-haiku-5-5"), TEXT_ONLY]);
      const d = await routeTask(
        makeRequest({
          text: "look",
          attachments: [{ kind: "image" }],
          pins: {
            model: { provider: "deepseek", model: "textonly-coder" },
            effort: "low",
            executionMode: "standard",
          },
        }),
        deps(null, { registry }),
      );
      expect(d.model).toBe("textonly-coder");
      expect(d.explanation).toBe("Your pinned model can't read images");
    });
  });

  describe("cache", () => {
    it("avoids repeat adapter calls and invalidates on config / attachment / availability changes", async () => {
      const cache = new RouteCache();
      const a = adapterOf(async () => choice());
      const req = makeRequest({ text: "what is a monad" });
      await routeTask(req, deps(a, { cache }));
      const hit = await routeTask(req, deps(a, { cache }));
      expect(hit.source).toBe("cache");
      expect(a.calls).toBe(1);
      await routeTask(req, deps(a, { cache, config: makeConfig({ confidenceThreshold: 0.7 }) }));
      expect(a.calls).toBe(2);
      await routeTask({ ...req, attachments: [{ kind: "image" }] }, deps(a, { cache }));
      expect(a.calls).toBe(3);
      const reg = makeRegistry().filter((c) => c.model !== "claude-opus-5-5");
      await routeTask(req, deps(a, { cache, registry: reg }));
      expect(a.calls).toBe(4);
    });

    it("reuses the previous decision for follow-ups", async () => {
      const cache = new RouteCache();
      const a = adapterOf(async () => choice());
      await routeTask(makeRequest({ text: "refactor the parser please" }), deps(a, { cache }));
      const d = await routeTask(makeRequest({ text: "continue" }), deps(a, { cache }));
      expect(d.source).toBe("cache");
      expect(a.calls).toBe(1);
    });

    it("is bounded", () => {
      const c = new RouteCache({ max: 2 });
      const d = { latencyMs: 0 } as never;
      c.set("a", d, 1000);
      c.set("b", d, 1000);
      c.set("c", d, 1000);
      expect(c.size).toBe(2);
      expect(c.get("a")).toBeUndefined();
    });
  });

  it("never leaks secrets or text into errors or diagnostics", async () => {
    const SECRET = "sk-or-FAKESECRETKEY1234567890";
    const logs: RouteDiagnostic[] = [];
    const a = adapterOf(async () => {
      throw new DecisionError("provider_error");
    });
    const d = await routeTask(
      makeRequest({ text: `my key is ${SECRET} fix it` }),
      deps(a, { log: (e: RouteDiagnostic) => logs.push(e) }),
    );
    const dump = JSON.stringify([d, logs]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("fix it");
    expect(logs[0]!.textLength).toBeGreaterThan(0);
  });

  it("survives a throwing log callback", async () => {
    const log = vi.fn(() => {
      throw new Error("x");
    });
    await expect(routeTask(makeRequest({ text: "hi" }), deps(null, { log }))).resolves.toBeTruthy();
  });
});
