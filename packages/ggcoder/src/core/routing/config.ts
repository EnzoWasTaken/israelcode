import { z } from "zod";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";

const THINKING = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

const clampNum = (min: number, max: number, def: number) =>
  z
    .number()
    .refine(Number.isFinite)
    .transform((n) => Math.min(max, Math.max(min, n)))
    .catch(def);

const deciderSchema = z
  .union([
    z.object({
      kind: z.literal("model"),
      provider: z.string().min(1),
      model: z.string().min(1),
    }),
    z.object({
      kind: z.literal("decisions-api"),
      service: z.enum(["openrouter", "typesafe"]),
      model: z.string().min(1),
    }),
  ])
  .nullable()
  .catch(null);

const escalationSchema = z
  .object({
    enabled: z.boolean().catch(true),
    maxAttempts: clampNum(0, 2, 1).transform((n) => Math.round(n)),
  })
  .catch({ enabled: true, maxAttempts: 1 });

export const autoRouteConfigSchema = z.object({
  enabled: z.boolean().catch(false),
  decider: deciderSchema,
  confidenceThreshold: clampNum(0, 1, 0.6),
  allowUltracode: z.boolean().catch(true),
  allowOrchestrate: z.boolean().catch(true),
  allowPaidModels: z.literal(false).catch(false),
  maxEffort: z.enum(THINKING).nullable().catch(null),
  maxCostTier: z.enum(["low", "medium", "high"]).catch("high"),
  candidateModels: z.array(z.string()).nullable().catch(null),
  escalation: escalationSchema,
  timeoutMs: clampNum(1000, 15000, 4000),
  cacheTtlMs: clampNum(0, 24 * 3600 * 1000, 600000),
});

export type AutoRouteConfig = z.output<typeof autoRouteConfigSchema> & {
  maxEffort: ThinkingLevel | null;
};

export const DEFAULT_AUTO_ROUTE_CONFIG: AutoRouteConfig = {
  enabled: false,
  decider: null,
  confidenceThreshold: 0.6,
  allowUltracode: true,
  allowOrchestrate: true,
  allowPaidModels: false,
  maxEffort: null,
  maxCostTier: "high",
  candidateModels: null,
  escalation: { enabled: true, maxAttempts: 1 },
  timeoutMs: 4000,
  cacheTtlMs: 600000,
};

/** Never throws: bad input yields defaults (per field where possible). */
export function parseAutoRouteConfig(input: unknown): AutoRouteConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ...DEFAULT_AUTO_ROUTE_CONFIG,
      escalation: { ...DEFAULT_AUTO_ROUTE_CONFIG.escalation },
    };
  }
  const parsed = autoRouteConfigSchema.safeParse(input);
  return parsed.success
    ? parsed.data
    : { ...DEFAULT_AUTO_ROUTE_CONFIG, escalation: { ...DEFAULT_AUTO_ROUTE_CONFIG.escalation } };
}

export type DecisionService = "openrouter" | "typesafe";

export const DECISION_SERVICE_DEFAULTS: Record<
  DecisionService,
  { label: string; endpoint: string; defaultModel: string; credentialKey: string }
> = {
  openrouter: {
    label: "OpenRouter Decisions",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: "typesafe/jev-1.14",
    credentialKey: "openrouter",
  },
  typesafe: {
    label: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-latest",
    credentialKey: "typesafe",
  },
};

/** Human-readable problems with the configured decider (empty = OK). */
export function validateDecider(
  config: AutoRouteConfig,
  env: {
    isAvailable(provider: string, modelId: string): boolean;
    hasCredential(key: string): boolean;
  },
): string[] {
  const d = config.decider;
  if (!d) {
    return config.enabled
      ? ["No decision model selected — Auto will use built-in rules instead."]
      : [];
  }
  if (d.kind === "model") {
    return env.isAvailable(d.provider, d.model)
      ? []
      : [`Decision model ${d.model} isn't connected. Sign in to ${d.provider} or pick another.`];
  }
  const svc = DECISION_SERVICE_DEFAULTS[d.service];
  return env.hasCredential(svc.credentialKey)
    ? []
    : [`Add your ${svc.label} API key to use ${d.model} for Auto routing.`];
}
