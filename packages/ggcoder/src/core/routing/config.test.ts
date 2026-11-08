import { describe, expect, it } from "vitest";
import {
  DECISION_SERVICE_DEFAULTS,
  DEFAULT_AUTO_ROUTE_CONFIG,
  parseAutoRouteConfig,
  validateDecider,
} from "./config.js";

describe("parseAutoRouteConfig", () => {
  it("returns defaults for garbage and never throws", () => {
    for (const bad of [null, undefined, 5, "x", [], { enabled: "yes", timeoutMs: "fast" }]) {
      const c = parseAutoRouteConfig(bad);
      expect(c.enabled).toBe(false);
      expect(c.timeoutMs).toBe(4000);
      expect(c.decider).toBeNull();
      expect(c.allowPaidModels).toBe(false);
    }
    expect(parseAutoRouteConfig(undefined)).toEqual(DEFAULT_AUTO_ROUTE_CONFIG);
  });

  it("clamps numeric fields", () => {
    const c = parseAutoRouteConfig({
      confidenceThreshold: 7,
      timeoutMs: 10,
      escalation: { maxAttempts: 9, enabled: true },
    });
    expect(c.confidenceThreshold).toBe(1);
    expect(c.timeoutMs).toBe(1000);
    expect(c.escalation.maxAttempts).toBe(2);
    expect(parseAutoRouteConfig({ timeoutMs: 99999 }).timeoutMs).toBe(15000);
  });

  it("never lets paid models be enabled", () => {
    expect(parseAutoRouteConfig({ allowPaidModels: true }).allowPaidModels).toBe(false);
  });

  it("keeps valid deciders and drops invalid ones", () => {
    const ok = { kind: "decisions-api", service: "openrouter", model: "typesafe/jev-1.14" };
    expect(parseAutoRouteConfig({ decider: ok }).decider).toEqual(ok);
    expect(
      parseAutoRouteConfig({ decider: { kind: "decisions-api", service: "x", model: "m" } })
        .decider,
    ).toBeNull();
  });
});

describe("validateDecider", () => {
  const env = { isAvailable: () => false, hasCredential: () => false };
  it("reports problems", () => {
    const model = parseAutoRouteConfig({
      enabled: true,
      decider: { kind: "model", provider: "anthropic", model: "claude-haiku-5-5" },
    });
    expect(validateDecider(model, env)).toHaveLength(1);
    const api = parseAutoRouteConfig({
      decider: { kind: "decisions-api", service: "typesafe", model: "jev-latest" },
    });
    expect(validateDecider(api, env)[0]).toContain("API key");
    expect(validateDecider(api, { ...env, hasCredential: (k) => k === "typesafe" })).toEqual([]);
  });
  it("exposes service defaults", () => {
    expect(DECISION_SERVICE_DEFAULTS.openrouter.defaultModel).toBe("typesafe/jev-1.14");
    expect(DECISION_SERVICE_DEFAULTS.typesafe.endpoint).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
  });
});
