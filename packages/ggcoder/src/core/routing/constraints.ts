import type { AutoRouteConfig } from "./config.js";
import { allowedExecutionModes, type ModelCapability } from "./capabilities.js";
import type { RouteSignals } from "./signals.js";
import type { ExecutionMode, RouteRequest } from "./types.js";

const TIER_RANK = { low: 0, medium: 1, high: 2 } as const;

export type UnmetConstraint = "no_models" | "vision" | "video" | "context";

export interface Constraints {
  candidates: ModelCapability[];
  allowedModes: ExecutionMode[];
  unmet: UnmetConstraint | null;
}

/** Hard constraints: availability, paid, tier cap, modalities, context window. */
export function resolveConstraints(
  req: RouteRequest,
  signals: RouteSignals,
  config: AutoRouteConfig,
  registry: readonly ModelCapability[],
  exclude?: (c: ModelCapability) => boolean,
): Constraints {
  const allowedModes = allowedExecutionModes(req, config);
  const allow = config.candidateModels?.length ? new Set(config.candidateModels) : null;
  let pool = registry.filter(
    (c) =>
      c.available &&
      !c.paid &&
      TIER_RANK[c.costTier] <= TIER_RANK[config.maxCostTier] &&
      (!allow || allow.has(c.model) || allow.has(`${c.provider}:${c.model}`)) &&
      !(exclude && exclude(c)),
  );
  let unmet: UnmetConstraint | null = pool.length === 0 ? "no_models" : null;
  const step = (keep: (c: ModelCapability) => boolean, why: UnmetConstraint) => {
    if (unmet) return;
    pool = pool.filter(keep);
    if (pool.length === 0) unmet = why;
  };
  if (signals.needsImage) step((c) => c.vision, "vision");
  if (signals.needsVideo) step((c) => c.video, "video");
  step((c) => c.contextWindow >= signals.contextTokensNeeded, "context");
  return { candidates: unmet ? [] : pool, allowedModes, unmet };
}
