import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AutoRouteConfig } from "./config.js";

export type { AutoRouteConfig };

export type ExecutionMode = "standard" | "ultracode" | "orchestrate";
export type TaskKind = "conversation" | "coding" | "debugging" | "planning" | "research" | "vision";
export type Difficulty = "trivial" | "simple" | "moderate" | "hard";

export interface RoutePins {
  model?: { provider: string; model: string };
  effort?: ThinkingLevel;
  executionMode?: ExecutionMode;
}

export interface RouteAttachment {
  kind: "image" | "video" | "document" | "audio" | "other";
  mime?: string;
  bytes?: number;
}

export interface RouteRequest {
  text: string;
  attachments: RouteAttachment[];
  workspace: "code" | "chat" | "motion";
  isGoal: boolean;
  hasSpawnAgent: boolean;
  conversation: {
    sessionKey: string;
    turns: number;
    estimatedTokens: number;
    /** Last ~2 user texts, truncated. */
    recentUserTexts?: string[];
    historyHasImages?: boolean;
  };
  current: {
    provider: string;
    model: string;
    thinkingLevel: ThinkingLevel | null;
    executionMode: ExecutionMode;
  };
  pins: RoutePins;
}

export type RouteFallbackReason =
  | "disabled"
  | "no_decision_provider"
  | "missing_credentials"
  | "timeout"
  | "provider_error"
  | "rate_limited"
  | "invalid_output"
  | "low_confidence"
  | "constraint_violation";

export type RouteReasonCode =
  | "image_analysis"
  | "video_analysis"
  | "quick_question"
  | "complex_task"
  | "debugging"
  | "planning"
  | "research"
  | "coding"
  | "orchestration"
  | "ultracode"
  | "kept_current"
  | "balanced_default"
  | "pinned"
  | "pinned_invalid"
  | "disabled"
  | "auto_unavailable"
  | "no_capable_model"
  | "escalated";

export interface RouteUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface RouteDecision {
  provider: string;
  model: string;
  effort: ThinkingLevel | null;
  executionMode: ExecutionMode;
  source: "router" | "fallback" | "pinned" | "cache";
  confidence: number;
  reason: RouteReasonCode;
  /** Short user-facing text. Never contains task text or secrets. */
  explanation: string;
  taskKind: TaskKind;
  difficulty: Difficulty;
  decisionModel?: string;
  fallbackReason?: RouteFallbackReason;
  usage?: RouteUsage;
  latencyMs: number;
}
