import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getSupportedThinkingLevels } from "@kenkaiiii/gg-core";
import type { ModelInfo } from "../model-registry.js";
import type { AutoRouteConfig } from "./config.js";
import type { ExecutionMode, RouteRequest } from "./types.js";

export type Strength = "coding" | "reasoning" | "vision" | "fast" | "general";

export interface ModelCapability {
  provider: string;
  model: string;
  name: string;
  vision: boolean;
  video: boolean;
  tools: true;
  contextWindow: number;
  costTier: "low" | "medium" | "high";
  thinkingLevels: ThinkingLevel[];
  strengths: Strength[];
  /** Unitless: 1 = cheapest class. */
  relativeCost: number;
  /** Unitless: 1 = fastest class. */
  relativeLatency: number;
  available: boolean;
  paid: boolean;
}

interface FamilyProfile {
  match: RegExp;
  strengths: Exclude<Strength, "vision">[];
  relativeCost: number;
  relativeLatency: number;
}

/** First match wins. Order matters (more specific first). Vision is never listed here. */
export const FAMILY_PROFILES: readonly FamilyProfile[] = [
  { match: /haiku/i, strengths: ["fast", "general"], relativeCost: 1, relativeLatency: 1 },
  { match: /flash-lite/i, strengths: ["fast", "general"], relativeCost: 1, relativeLatency: 1 },
  {
    match: /gemini.*flash/i,
    strengths: ["fast", "general", "coding"],
    relativeCost: 1.5,
    relativeLatency: 1.2,
  },
  {
    match: /gemini.*pro/i,
    strengths: ["reasoning", "coding", "general"],
    relativeCost: 5,
    relativeLatency: 3,
  },
  { match: /sonnet/i, strengths: ["coding", "general"], relativeCost: 3, relativeLatency: 2 },
  {
    match: /opus|fable|mythos/i,
    strengths: ["reasoning", "coding"],
    relativeCost: 8,
    relativeLatency: 3,
  },
  { match: /luna/i, strengths: ["coding", "general"], relativeCost: 3, relativeLatency: 2 },
  {
    match: /astra|sol\b/i,
    strengths: ["reasoning", "coding"],
    relativeCost: 9,
    relativeLatency: 4,
  },
];

const TIER_DEFAULTS: Record<
  "low" | "medium" | "high",
  Pick<FamilyProfile, "strengths" | "relativeCost" | "relativeLatency">
> = {
  low: { strengths: ["fast", "general"], relativeCost: 1, relativeLatency: 1 },
  medium: { strengths: ["coding", "general"], relativeCost: 3, relativeLatency: 2 },
  high: { strengths: ["reasoning", "coding"], relativeCost: 8, relativeLatency: 3 },
};

export interface BuildRegistryOptions {
  models: readonly ModelInfo[];
  isAvailable(provider: string, modelId: string): boolean;
  /** Paid tiers are never auto-selected; the flag exists only to make that explicit. */
  allowPaid?: false;
  /** Model ids (or `provider:model` keys) to restrict to. */
  candidateAllowList?: readonly string[] | null;
}

export function capabilityKey(c: { provider: string; model: string }): string {
  return `${c.provider}:${c.model}`;
}

/** Only available, non-paid, allow-listed models are returned. */
export function buildCapabilityRegistry(opts: BuildRegistryOptions): ModelCapability[] {
  const allow = opts.candidateAllowList?.length ? new Set(opts.candidateAllowList) : null;
  const out: ModelCapability[] = [];
  for (const m of opts.models) {
    const paid = m.billing?.paid === true;
    if (paid) continue;
    if (!opts.isAvailable(m.provider, m.id)) continue;
    if (allow && !allow.has(m.id) && !allow.has(`${m.provider}:${m.id}`)) continue;
    const profile = FAMILY_PROFILES.find((p) => p.match.test(m.id)) ?? TIER_DEFAULTS[m.costTier];
    const strengths: Strength[] = [...profile.strengths];
    if (m.supportsImages) strengths.push("vision");
    out.push({
      provider: m.provider,
      model: m.id,
      name: m.name,
      vision: m.supportsImages,
      video: m.supportsVideo,
      tools: true,
      contextWindow: m.contextWindow,
      costTier: m.costTier,
      thinkingLevels: m.supportsThinking ? [...getSupportedThinkingLevels(m.provider, m.id)] : [],
      strengths,
      relativeCost: profile.relativeCost,
      relativeLatency: profile.relativeLatency,
      available: true,
      paid,
    });
  }
  return out;
}

export interface ExecutionModeSpec {
  id: ExecutionMode;
  label: string;
  requiresCodeWorkspace: boolean;
  requiresSpawnAgent: boolean;
  forbidsGoal: boolean;
  suitability: string;
}

export const EXECUTION_MODES: Record<ExecutionMode, ExecutionModeSpec> = {
  standard: {
    id: "standard",
    label: "Standard",
    requiresCodeWorkspace: false,
    requiresSpawnAgent: false,
    forbidsGoal: false,
    suitability: "Direct execution by the main model. Default for almost everything.",
  },
  ultracode: {
    id: "ultracode",
    label: "Ultracode",
    requiresCodeWorkspace: true,
    requiresSpawnAgent: true,
    forbidsGoal: true,
    suitability:
      "Big multi-file jobs: plan phases, fan out parallel children, adversarial review, combine.",
  },
  orchestrate: {
    id: "orchestrate",
    label: "Orchestrate",
    requiresCodeWorkspace: true,
    requiresSpawnAgent: true,
    forbidsGoal: true,
    suitability:
      "Large decomposable work where the main model only plans, delegates and reviews; children run on the Worker model.",
  },
};

export function allowedExecutionModes(
  req: Pick<RouteRequest, "workspace" | "isGoal" | "hasSpawnAgent">,
  config: Pick<AutoRouteConfig, "allowUltracode" | "allowOrchestrate">,
): ExecutionMode[] {
  const modes: ExecutionMode[] = ["standard"];
  const ok = (m: ExecutionMode) => {
    const s = EXECUTION_MODES[m];
    return (
      (!s.requiresCodeWorkspace || req.workspace === "code") &&
      (!s.requiresSpawnAgent || req.hasSpawnAgent) &&
      (!s.forbidsGoal || !req.isGoal)
    );
  };
  if (config.allowUltracode && ok("ultracode")) modes.push("ultracode");
  if (config.allowOrchestrate && ok("orchestrate")) modes.push("orchestrate");
  return modes;
}

export const THINKING_LADDER: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LADDER as readonly string[]).includes(v);
}

/** Nearest supported level (ties go lower). Empty `levels` → null (no thinking). */
export function clampEffort(
  effort: ThinkingLevel,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  if (levels.length === 0) return null;
  const target = THINKING_LADDER.indexOf(effort);
  let best = levels[0]!;
  let bestDist = Infinity;
  for (const l of levels) {
    const d = Math.abs(THINKING_LADDER.indexOf(l) - target);
    if (
      d < bestDist ||
      (d === bestDist && THINKING_LADDER.indexOf(l) < THINKING_LADDER.indexOf(best))
    ) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

/** Cap `effort` at `max` (no-op when max is null). */
export function capEffort(
  effort: ThinkingLevel | null,
  max: ThinkingLevel | null,
): ThinkingLevel | null {
  if (!effort || !max) return effort;
  return THINKING_LADDER.indexOf(effort) > THINKING_LADDER.indexOf(max) ? max : effort;
}

export function qualityScore(c: ModelCapability): number {
  return (
    (c.strengths.includes("reasoning") ? 3 : 0) +
    (c.strengths.includes("coding") ? 2 : 0) +
    (c.strengths.includes("general") ? 1 : 0) +
    c.relativeCost * 0.1
  );
}
