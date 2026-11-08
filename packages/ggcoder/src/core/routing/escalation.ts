import { capEffort, clampEffort, qualityScore, type ModelCapability } from "./capabilities.js";
import type { AutoRouteConfig } from "./config.js";
import { resolveConstraints } from "./constraints.js";
import { explainEscalation } from "./explain.js";
import { extractSignals } from "./signals.js";
import type { RouteDecision, RouteRequest } from "./types.js";

export type EscalationFailure = {
  kind: "rate_limited" | "provider_unavailable" | "context_overflow" | "model_error";
};

export interface EscalationDeps {
  config: AutoRouteConfig;
  registry: readonly ModelCapability[];
  /** The original request (for modality / context / mode constraints). */
  request: RouteRequest;
}

/**
 * Next safe alternative after `prev` failed, or null. `attempt` is the 1-based
 * number of this escalation (1 = first retry); it is bounded by
 * `config.escalation.maxAttempts`. Pinned models are never replaced.
 */
export function nextEscalation(
  prev: RouteDecision,
  failure: EscalationFailure,
  attempt: number,
  deps: EscalationDeps,
): RouteDecision | null {
  const { config, registry, request } = deps;
  if (!config.enabled || !config.escalation.enabled) return null;
  if (attempt < 1 || attempt > config.escalation.maxAttempts) return null;
  if (prev.source === "pinned" || request.pins.model) return null;

  const signals = extractSignals(request);
  const failed = registry.find((c) => c.provider === prev.provider && c.model === prev.model);
  const providerWide = failure.kind === "rate_limited" || failure.kind === "provider_unavailable";
  const { candidates, allowedModes } = resolveConstraints(
    request,
    signals,
    config,
    registry,
    (c) => c.provider === prev.provider && (providerWide || c.model === prev.model),
  );
  let pool = candidates;
  if (failure.kind === "context_overflow") {
    const floor = failed?.contextWindow ?? 0;
    pool = pool.filter((c) => c.contextWindow > floor);
  }
  if (pool.length === 0) return null;

  const target = failed ? qualityScore(failed) : 0;
  const next = [...pool].sort((a, b) =>
    failure.kind === "context_overflow"
      ? a.contextWindow - b.contextWindow
      : Math.abs(qualityScore(a) - target) - Math.abs(qualityScore(b) - target) ||
        a.relativeCost - b.relativeCost,
  )[0]!;

  const effort = prev.effort
    ? capEffort(clampEffort(prev.effort, next.thinkingLevels), config.maxEffort)
    : null;
  return {
    ...prev,
    provider: next.provider,
    model: next.model,
    effort,
    executionMode: allowedModes.includes(prev.executionMode) ? prev.executionMode : "standard",
    source: "fallback",
    reason: "escalated",
    explanation: explainEscalation(next.name, failed?.name ?? prev.model, failure.kind),
    fallbackReason: undefined,
    decisionModel: undefined,
    usage: undefined,
    latencyMs: 0,
  };
}
