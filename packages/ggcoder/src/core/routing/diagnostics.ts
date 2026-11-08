import { shortHash } from "./hash.js";
import type {
  Difficulty,
  ExecutionMode,
  RouteDecision,
  RouteFallbackReason,
  RouteReasonCode,
  RouteRequest,
  RouteUsage,
  TaskKind,
} from "./types.js";

/** Structured, secret-free record of one routing decision. Never holds task text. */
export interface RouteDiagnostic {
  timestamp: number;
  sessionHash: string;
  provider: string;
  model: string;
  effort: string | null;
  executionMode: ExecutionMode;
  source: RouteDecision["source"];
  reason: RouteReasonCode;
  fallbackReason?: RouteFallbackReason;
  taskKind: TaskKind;
  difficulty: Difficulty;
  confidence: number;
  decisionModel?: string;
  latencyMs: number;
  usage?: RouteUsage;
  workspace: RouteRequest["workspace"];
  attachmentKinds: string[];
  textLength: number;
  textHash: string;
}

export function toDiagnostic(
  decision: RouteDecision,
  req: RouteRequest,
  timestamp: number = Date.now(),
): RouteDiagnostic {
  return {
    timestamp,
    sessionHash: shortHash(req.conversation.sessionKey, 12),
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    executionMode: decision.executionMode,
    source: decision.source,
    reason: decision.reason,
    ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
    taskKind: decision.taskKind,
    difficulty: decision.difficulty,
    confidence: decision.confidence,
    ...(decision.decisionModel ? { decisionModel: decision.decisionModel } : {}),
    latencyMs: decision.latencyMs,
    ...(decision.usage ? { usage: decision.usage } : {}),
    workspace: req.workspace,
    attachmentKinds: [...new Set(req.attachments.map((a) => a.kind))].sort(),
    textLength: req.text.length,
    textHash: shortHash(req.text, 8),
  };
}
