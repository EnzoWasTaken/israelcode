import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import {
  getMaxThinkingLevel,
  getModel,
  usesOpenAICodexTransport,
  type ContextWindowOptions,
} from "./model-registry.js";

const OPENAI_GPT_THINKING_LEVELS: readonly ThinkingLevel[] = ["medium", "high", "xhigh"];
// GPT-5.6 and GPT-6.x (gpt-6-*, plus point releases like gpt-6.1-sol) share the
// six-rung Codex ladder (low → ultra); older GPT models only expose
// medium/high/xhigh.
// The ChatGPT (Codex) ladder; API-key requests drop `ultra`, which the API does not accept.
const OPENAI_GPT_56_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
// Plain Fugu and Fugu Max stop at xhigh; Ultra adds max. Slice by the model ceiling.
const SAKANA_THINKING_LEVELS: readonly ThinkingLevel[] = ["high", "xhigh", "max"];
const DEEPSEEK_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "high", "max"];
// Grok reasoning models take reasoning_effort low/medium/high (server default
// high; reasoning can't be fully disabled — "off" just omits the param). The
// registered Grok (4.7) exposes the full ladder including the `xhigh` top
// rung (docs: low/medium/high default/xhigh); each model slices this ladder
// by its registry maxThinkingLevel.
const XAI_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];
// Opus 5.x / 4.7, Sonnet 5.5, Haiku 5.5, Fable 5 and Mythos 5 expose the full ladder including xhigh.
// Other adaptive Anthropic models omit xhigh and would 400.
const ANTHROPIC_XHIGH_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const ANTHROPIC_ADAPTIVE_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];
// Kimi K3's effort ladder is declared server-side via /models think_efforts:
// ["low","high","max"] on both the public API (default max) and the Kimi For
// Coding OAuth endpoint (default high) — verified live 2026-07-21. Unlisted
// efforts are rejected with a 400, so expose exactly the declared rungs.
const MOONSHOT_K3_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "high", "max"];
// docs.z.ai lists only low/high/max for GLM; medium and xhigh are server aliases,
// so offering them would show rungs that do nothing distinct.
const GLM_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "high", "max"];
const LOW_MEDIUM_HIGH_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"];
// MiniMax M3.1 Flash: output_config.effort accepts low/medium/high/xhigh/max
// (platform.minimax.io Anthropic API docs); M3 has only on/off thinking.
const MINIMAX_EFFORT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
/**
 * Effort ladder for locally hosted models. `xhigh`/`ultra` are deliberately
 * absent: no local server defines them (Ollama 0.32 answers
 * `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or
 * "none")`). Each model's own ceiling comes from its endpoint — see
 * `toModelInfo` in local-models.ts.
 */
const LOCAL_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "max"];

function isOpenAIGptModel(provider: Provider, model: string): boolean {
  return provider === "openai" && model.startsWith("gpt-");
}

function isSakanaModel(provider: Provider): boolean {
  return provider === "sakana";
}

function isXaiModel(provider: Provider): boolean {
  return provider === "xai";
}

// K3 and K2.8 Preview (`kimi-for-coding`) declare the same low/high/max ladder.
function isMoonshotK3Model(provider: Provider, model: string): boolean {
  return provider === "moonshot" && (model === "kimi-k3" || model === "kimi-for-coding");
}

function isGlmModel(provider: Provider): boolean {
  return provider === "glm";
}

function isMiniMaxEffortModel(provider: Provider, model: string): boolean {
  return provider === "minimax" && model.startsWith("MiniMax-M3.1");
}

function isAnthropicXhighModel(provider: Provider, model: string): boolean {
  return (
    provider === "anthropic" &&
    /opus-5|opus-4-8|opus-4-7|sonnet-5[-.]5|haiku-5[-.]5|fable-5|mythos-5/.test(model)
  );
}

function isAnthropicAdaptiveModel(provider: Provider, model: string): boolean {
  return (
    provider === "anthropic" &&
    /opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|haiku-5|fable-5|mythos-5/.test(model)
  );
}

export function getSupportedThinkingLevels(
  provider: Provider,
  model: string,
  options?: ContextWindowOptions,
): readonly ThinkingLevel[] {
  if (provider !== "local" && getModel(model)?.supportsThinking === false) return [];
  // Local models: reasoning support is per-model and probed, not assumed. A
  // non-reasoning local model must never be sent a reasoning_effort — Ollama
  // hard-400s (`"llama3.2" does not support thinking`) — so it offers no levels
  // at all and the thinking toggle stays hidden.
  if (provider === "local") {
    const info = getModel(model);
    if (!info?.supportsThinking) return [];
    // The ceiling is the endpoint's, set at discovery: Ollama takes
    // low/medium/high/max, while the other OpenAI-compatible servers only
    // define low/medium/high (verified — Ollama rejects xhigh outright).
    const maxIndex = LOCAL_THINKING_LEVELS.indexOf(info.maxThinkingLevel);
    return maxIndex === -1
      ? LOCAL_THINKING_LEVELS.slice(0, 3)
      : LOCAL_THINKING_LEVELS.slice(0, maxIndex + 1);
  }
  const declared = getModel(model)?.thinkingLevels;
  if (declared && declared.length > 0) return declared;
  const maxLevel = getMaxThinkingLevel(model);
  if (isAnthropicAdaptiveModel(provider, model)) {
    const levels = isAnthropicXhighModel(provider, model)
      ? ANTHROPIC_XHIGH_THINKING_LEVELS
      : ANTHROPIC_ADAPTIVE_THINKING_LEVELS;
    const maxIndex = levels.indexOf(maxLevel);
    if (maxIndex === -1) return ["low", "medium", "high"];
    return levels.slice(0, maxIndex + 1);
  }

  if (isSakanaModel(provider)) {
    const maxIndex = SAKANA_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return SAKANA_THINKING_LEVELS;
    return SAKANA_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (isXaiModel(provider)) {
    const maxIndex = XAI_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return XAI_THINKING_LEVELS;
    return XAI_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (isMoonshotK3Model(provider, model)) return MOONSHOT_K3_THINKING_LEVELS;
  if (provider === "deepseek") return DEEPSEEK_THINKING_LEVELS;

  if (isMiniMaxEffortModel(provider, model)) return MINIMAX_EFFORT_THINKING_LEVELS;

  if (provider === "gemini") return LOW_MEDIUM_HIGH_THINKING_LEVELS;
  if (provider === "huggingface" && model.endsWith("gpt-oss-120b")) {
    return LOW_MEDIUM_HIGH_THINKING_LEVELS;
  }

  if (isGlmModel(provider)) {
    const maxIndex = GLM_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return GLM_THINKING_LEVELS;
    return GLM_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (!isOpenAIGptModel(provider, model)) return [maxLevel];

  const levels =
    model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-") || model.startsWith("gpt-6.")
      ? OPENAI_GPT_56_THINKING_LEVELS
      : OPENAI_GPT_THINKING_LEVELS;
  const maxIndex = levels.indexOf(maxLevel);
  if (maxIndex === -1) return ["medium"];
  const sliced = levels.slice(0, maxIndex + 1);
  // `ultra` is Codex-only; the codex models.json ladders match the registry ceilings.
  return levels === OPENAI_GPT_56_THINKING_LEVELS && !usesOpenAICodexTransport(options)
    ? sliced.filter((level) => level !== "ultra")
    : sliced;
}

/**
 * The lowest effort `model` accepts — the first rung of its ladder, never
 * "off". Used for background work (compaction summaries, `model: fast`
 * agents) that runs on the active model but doesn't need deep reasoning.
 * Undefined only when the model cannot reason at all, since sending it any
 * effort would be rejected.
 */
export function getLowestThinkingLevel(
  provider: Provider,
  model: string,
  options?: ContextWindowOptions,
): ThinkingLevel | undefined {
  if (getModel(model)?.supportsThinking === false) return undefined;
  return getSupportedThinkingLevels(provider, model, options)[0];
}

export function isThinkingLevelSupported(
  provider: Provider,
  model: string,
  level: ThinkingLevel,
  options?: ContextWindowOptions,
): boolean {
  return getSupportedThinkingLevels(provider, model, options).includes(level);
}

export function getNextThinkingLevel(
  provider: Provider,
  model: string,
  current: ThinkingLevel | undefined,
  options?: ContextWindowOptions,
): ThinkingLevel | undefined {
  const supportedLevels = getSupportedThinkingLevels(provider, model, options);
  // A single-rung model is an on/off toggle.
  if (supportedLevels.length <= 1) {
    return current ? undefined : supportedLevels[0];
  }

  if (!current) return supportedLevels[0];
  const index = supportedLevels.indexOf(current);
  if (index === -1) return supportedLevels[0];
  return supportedLevels[index + 1];
}

/**
 * Reasoning effort ceiling applied while plan mode is active. Mirrors the
 * Codex CLI's `plan_mode_reasoning_effort` preset (currently `medium`):
 * plan mode is read-only exploration, and deep-reasoning models left at
 * high/xhigh/max spend enormous thinking budgets re-deriving context they
 * could not have acted on anyway.
 */
export const PLAN_MODE_THINKING_CAP: ThinkingLevel = "medium";

const THINKING_LADDER: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** Clamp a thinking level down to the plan-mode cap. Pass-through for
 * `undefined` (thinking off) and already-low levels. */
export function clampThinkingForPlanMode(
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!level) return level;
  return THINKING_LADDER.indexOf(level) > THINKING_LADDER.indexOf(PLAN_MODE_THINKING_CAP)
    ? PLAN_MODE_THINKING_CAP
    : level;
}

/** Nearest supported rung to `level`; ties go lower. */
export function clampThinkingLevel(
  provider: Provider,
  model: string,
  level: ThinkingLevel | undefined,
  options?: ContextWindowOptions,
): ThinkingLevel | undefined {
  if (!level) return undefined;
  const supported = getSupportedThinkingLevels(provider, model, options);
  if (supported.length === 0) return undefined;
  if (supported.includes(level)) return level;
  const target = THINKING_LADDER.indexOf(level);
  let best = supported[0]!;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = Math.abs(THINKING_LADDER.indexOf(candidate) - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
