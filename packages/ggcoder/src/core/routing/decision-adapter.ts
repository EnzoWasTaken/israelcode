import { redactText } from "@kenkaiiii/gg-ai";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { capabilityKey, clampEffort, type ModelCapability, type Strength } from "./capabilities.js";
import type { Constraints } from "./constraints.js";
import type { RouteSignals } from "./signals.js";
import type {
  Difficulty,
  ExecutionMode,
  RouteFallbackReason,
  RouteRequest,
  RouteUsage,
  TaskKind,
} from "./types.js";

export const MAX_DECISION_TEXT_CHARS = 4000;
export const DIFFICULTY_LEVELS: readonly Difficulty[] = ["trivial", "simple", "moderate", "hard"];
export const TASK_KINDS: readonly TaskKind[] = [
  "conversation",
  "coding",
  "debugging",
  "planning",
  "research",
  "vision",
];

export interface CandidateView {
  /** Stable key `provider:model`; what adapters must return in `model`. */
  id: string;
  name: string;
  vision: boolean;
  video: boolean;
  strengths: Strength[];
  costTier: "low" | "medium" | "high";
  relativeCost: number;
  relativeLatency: number;
  thinkingLevels: ThinkingLevel[];
  description: string;
}

export interface DecisionInput {
  signals: {
    needsImage: boolean;
    needsVideo: boolean;
    taskKindHint: TaskKind;
    difficultyHint: Difficulty;
    contextTokensNeeded: number;
    stepCount: number;
    fileMentions: number;
    isFollowUp: boolean;
    workspace: RouteRequest["workspace"];
  };
  candidates: CandidateView[];
  allowedModes: ExecutionMode[];
  /** Redacted and truncated task text. */
  taskText: string;
  currentModel: string;
}

/** Raw, unvalidated adapter output. The router validates every field. */
export interface RawRouteChoice {
  model: string;
  effort: string | null;
  executionMode: string;
  taskKind: string;
  difficulty: string;
  confidence: number;
  usage?: RouteUsage;
}

export interface DecisionAdapter {
  id: string;
  label: string;
  decide(input: DecisionInput, signal: AbortSignal): Promise<RawRouteChoice>;
}

/** Thrown by adapters. Carries only a reason code: never keys, bodies or task text. */
export class DecisionError extends Error {
  readonly reason: RouteFallbackReason;
  constructor(reason: RouteFallbackReason, message?: string) {
    super(message ?? reason);
    this.name = "DecisionError";
    this.reason = reason;
  }
}

export function truncateTaskText(text: string, extraSecrets: Iterable<string> = []): string {
  const safe = redactText(text, { secrets: extraSecrets });
  if (safe.length <= MAX_DECISION_TEXT_CHARS) return safe;
  return `${safe.slice(0, 2800)}\n…\n${safe.slice(-1100)}`;
}

export function describeCandidate(c: ModelCapability): CandidateView {
  const id = capabilityKey(c);
  return {
    id,
    name: c.name,
    vision: c.vision,
    video: c.video,
    strengths: c.strengths,
    costTier: c.costTier,
    relativeCost: c.relativeCost,
    relativeLatency: c.relativeLatency,
    thinkingLevels: c.thinkingLevels,
    description: `${c.name}: ${c.strengths.join("/")}; cost ${c.relativeCost}/10, latency ${c.relativeLatency}/4${
      c.vision ? "; reads images" : ""
    }${c.video ? "; reads video" : ""}`,
  };
}

export function buildDecisionInput(
  req: RouteRequest,
  signals: RouteSignals,
  constraints: Constraints,
  extraSecrets: Iterable<string> = [],
): DecisionInput {
  return {
    signals: {
      needsImage: signals.needsImage,
      needsVideo: signals.needsVideo,
      taskKindHint: signals.taskKind,
      difficultyHint: signals.difficulty,
      contextTokensNeeded: signals.contextTokensNeeded,
      stepCount: signals.stepCount,
      fileMentions: signals.fileMentions,
      isFollowUp: signals.isFollowUp,
      workspace: req.workspace,
    },
    candidates: constraints.candidates.map(describeCandidate),
    allowedModes: constraints.allowedModes,
    taskText: truncateTaskText(req.text, extraSecrets),
    currentModel: `${req.current.provider}:${req.current.model}`,
  };
}

/** Effort policy shared by adapters and the deterministic fallback. */
export function effortForDifficulty(
  difficulty: Difficulty,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  const wanted: ThinkingLevel =
    difficulty === "hard" ? "high" : difficulty === "moderate" ? "medium" : "low";
  return clampEffort(wanted, levels);
}
