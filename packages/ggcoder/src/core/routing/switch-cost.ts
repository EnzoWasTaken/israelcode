import { qualityScore, type ModelCapability } from "./capabilities.js";
import type { Difficulty } from "./types.js";

/** Below this much conversation, a model flip costs little, so the router may switch freely. */
export const SWITCH_COST_MIN_CONTEXT_TOKENS = 8_000;
/** A decision this confident may override stickiness... */
export const SWITCH_OVERRIDE_CONFIDENCE = 0.9;
/** ...when the target is at least this much better by `qualityScore` (a real capability gap). */
export const SWITCH_OVERRIDE_QUALITY_GAP = 2;

/** Whether `cap` is strong enough for `difficulty` (trivial/simple: any candidate is). */
export function isAdequateFor(cap: ModelCapability, difficulty: Difficulty): boolean {
  if (difficulty === "hard") return cap.strengths.includes("reasoning") || cap.costTier === "high";
  if (difficulty === "moderate") {
    return cap.strengths.includes("coding") || cap.strengths.includes("reasoning");
  }
  return true;
}

/**
 * Switch-cost rule. Providers cache the prompt prefix per model, so every flip rewrites the whole
 * prefix (~1.25x input) instead of reading it (~0.1x) and adds a history note. Mid-conversation
 * with a sizeable context, stay on the current model when it passed the hard constraints
 * (`current` is one of the constraint-filtered candidates) and is adequate for the difficulty,
 * unless the decision is confident and the capability gap is real.
 */
export function shouldKeepCurrent(input: {
  turns: number;
  estimatedTokens: number;
  current: ModelCapability | undefined;
  target: ModelCapability;
  difficulty: Difficulty;
  confidence: number;
}): boolean {
  const { current, target } = input;
  if (!current || current === target) return false;
  if (input.turns <= 0 || input.estimatedTokens < SWITCH_COST_MIN_CONTEXT_TOKENS) return false;
  if (!isAdequateFor(current, input.difficulty)) return false;
  const gap = qualityScore(target) - qualityScore(current);
  return !(input.confidence >= SWITCH_OVERRIDE_CONFIDENCE && gap >= SWITCH_OVERRIDE_QUALITY_GAP);
}
