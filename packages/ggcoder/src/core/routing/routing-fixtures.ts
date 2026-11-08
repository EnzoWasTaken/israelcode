import { MODELS, type ModelInfo } from "../model-registry.js";
import { buildCapabilityRegistry, type ModelCapability } from "./capabilities.js";
import { parseAutoRouteConfig, type AutoRouteConfig } from "./config.js";
import type { RouteRequest } from "./types.js";

/** Test helpers: real catalog entries, with optional overrides. */
export function realModel(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  const base = MODELS.find((m) => m.id === id);
  if (!base) throw new Error(`unknown model ${id}`);
  return { ...base, ...over };
}

export const TEXT_ONLY: ModelInfo = {
  ...realModel("claude-sonnet-5-5"),
  id: "textonly-coder",
  name: "TextOnly Coder",
  provider: "deepseek",
  supportsImages: false,
  supportsVideo: false,
};

export const DEFAULT_MODEL_IDS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "gemini-3.1-flash-lite",
];

export function makeRegistry(models?: ModelInfo[]): ModelCapability[] {
  return buildCapabilityRegistry({
    models: models ?? DEFAULT_MODEL_IDS.map((id) => realModel(id)),
    isAvailable: () => true,
  });
}

export function makeConfig(over: Record<string, unknown> = {}): AutoRouteConfig {
  return parseAutoRouteConfig({ enabled: true, ...over });
}

export function makeRequest(over: Partial<RouteRequest> & { text: string }): RouteRequest {
  return {
    attachments: [],
    workspace: "code",
    isGoal: false,
    hasSpawnAgent: true,
    conversation: { sessionKey: "s1", turns: 2, estimatedTokens: 2000 },
    current: {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      thinkingLevel: "medium",
      executionMode: "standard",
    },
    pins: {},
    ...over,
  };
}
