import { describe, expect, it } from "vitest";
import { allowedExecutionModes, buildCapabilityRegistry, clampEffort } from "./capabilities.js";
import { realModel, TEXT_ONLY } from "./routing-fixtures.js";

describe("buildCapabilityRegistry", () => {
  it("derives vision only from supportsImages", () => {
    const reg = buildCapabilityRegistry({
      models: [realModel("claude-sonnet-5-5"), TEXT_ONLY],
      isAvailable: () => true,
    });
    expect(reg.find((c) => c.model === "claude-sonnet-5-5")?.vision).toBe(true);
    const t = reg.find((c) => c.model === "textonly-coder")!;
    expect(t.vision).toBe(false);
    expect(t.strengths).not.toContain("vision");
  });

  it("excludes paid and unavailable models, honours allow-list", () => {
    const paid = realModel("claude-opus-5-5", {
      id: "opus-fast",
      billing: { label: "bills credits", paid: true } as never,
    });
    const reg = buildCapabilityRegistry({
      models: [realModel("claude-haiku-5-5"), realModel("claude-sonnet-5-5"), paid],
      isAvailable: (_p, id) => id !== "claude-sonnet-5-5",
    });
    expect(reg.map((c) => c.model)).toEqual(["claude-haiku-5-5"]);
    const only = buildCapabilityRegistry({
      models: [realModel("claude-haiku-5-5"), realModel("claude-sonnet-5-5")],
      isAvailable: () => true,
      candidateAllowList: ["anthropic:claude-sonnet-5-5"],
    });
    expect(only.map((c) => c.model)).toEqual(["claude-sonnet-5-5"]);
  });

  it("falls back to cost tier for unknown models", () => {
    const [c] = buildCapabilityRegistry({
      models: [{ ...TEXT_ONLY, id: "mystery-1", costTier: "low" }],
      isAvailable: () => true,
    });
    expect(c!.strengths).toContain("fast");
    expect(c!.relativeCost).toBe(1);
  });
});

describe("modes and effort", () => {
  const cfg = { allowUltracode: true, allowOrchestrate: true };
  it("restricts modes by workspace, goal and spawn_agent", () => {
    const base = { workspace: "code" as const, isGoal: false, hasSpawnAgent: true };
    expect(allowedExecutionModes(base, cfg)).toEqual(["standard", "ultracode", "orchestrate"]);
    expect(allowedExecutionModes({ ...base, workspace: "chat" }, cfg)).toEqual(["standard"]);
    expect(allowedExecutionModes({ ...base, workspace: "motion" }, cfg)).toEqual(["standard"]);
    expect(allowedExecutionModes({ ...base, isGoal: true }, cfg)).toEqual(["standard"]);
    expect(allowedExecutionModes({ ...base, hasSpawnAgent: false }, cfg)).toEqual(["standard"]);
    expect(allowedExecutionModes(base, { ...cfg, allowOrchestrate: false })).toEqual([
      "standard",
      "ultracode",
    ]);
  });
  it("clamps effort to the nearest supported level", () => {
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("xhigh", ["low", "high"])).toBe("high");
    expect(clampEffort("medium", ["low", "high"])).toBe("low");
    expect(clampEffort("high", [])).toBeNull();
  });
});
