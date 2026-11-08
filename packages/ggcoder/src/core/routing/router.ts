import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import {
  capabilityKey,
  capEffort,
  clampEffort,
  isThinkingLevel,
  type ModelCapability,
} from "./capabilities.js";
import { routeCacheKey, type RouteCache } from "./cache.js";
import type { AutoRouteConfig } from "./config.js";
import { resolveConstraints, type Constraints } from "./constraints.js";
import {
  buildDecisionInput,
  DecisionError,
  DIFFICULTY_LEVELS,
  effortForDifficulty,
  TASK_KINDS,
  type DecisionAdapter,
  type RawRouteChoice,
} from "./decision-adapter.js";
import { toDiagnostic, type RouteDiagnostic } from "./diagnostics.js";
import { explainConstraintViolation, explainPinWarning, explainReason } from "./explain.js";
import { deterministicRoute } from "./fallback.js";
import { extractSignals, type RouteSignals } from "./signals.js";
import type {
  Difficulty,
  ExecutionMode,
  RouteDecision,
  RouteFallbackReason,
  RouteReasonCode,
  RouteRequest,
  TaskKind,
} from "./types.js";

export interface RouterDeps {
  config: AutoRouteConfig;
  registry: ModelCapability[];
  adapter: DecisionAdapter | null;
  cache?: RouteCache;
  now?: () => number;
  /** Overrides config.timeoutMs. */
  timeoutMs?: number;
  log?: (event: RouteDiagnostic) => void;
}

type Draft = Omit<RouteDecision, "latencyMs">;

function deriveReason(
  mode: ExecutionMode,
  s: RouteSignals,
  kind: TaskKind,
  difficulty: Difficulty,
  keptCurrent: boolean,
): RouteReasonCode {
  if (mode === "orchestrate") return "orchestration";
  if (mode === "ultracode") return "ultracode";
  if (s.needsImage) return "image_analysis";
  if (s.needsVideo) return "video_analysis";
  if (keptCurrent) return "kept_current";
  if (difficulty === "trivial" || (difficulty === "simple" && kind === "conversation")) {
    return "quick_question";
  }
  if (difficulty === "hard") return "complex_task";
  if (kind === "debugging") return "debugging";
  if (kind === "planning") return "planning";
  if (kind === "research") return "research";
  if (kind === "coding") return "coding";
  return "balanced_default";
}

function resolveKey(raw: string, candidates: readonly ModelCapability[]): ModelCapability | null {
  const exact = candidates.find((c) => capabilityKey(c) === raw);
  if (exact) return exact;
  const byId = candidates.filter((c) => c.model === raw);
  return byId.length === 1 ? byId[0]! : null;
}

type Validated =
  | {
      ok: true;
      cap: ModelCapability;
      effort: ThinkingLevel | null;
      mode: ExecutionMode;
      kind: TaskKind;
      difficulty: Difficulty;
    }
  | { ok: false; reason: RouteFallbackReason };

function validateRaw(raw: RawRouteChoice, cons: Constraints, config: AutoRouteConfig): Validated {
  const bad = { ok: false, reason: "invalid_output" } as const;
  if (!raw || typeof raw !== "object") return bad;
  if (typeof raw.confidence !== "number" || !(raw.confidence >= 0 && raw.confidence <= 1))
    return bad;
  const cap = typeof raw.model === "string" ? resolveKey(raw.model, cons.candidates) : null;
  if (!cap) return bad;
  const mode = cons.allowedModes.find((m) => m === raw.executionMode);
  if (!mode) return bad;
  const kind = TASK_KINDS.find((k) => k === raw.taskKind);
  const difficulty = DIFFICULTY_LEVELS.find((d) => d === raw.difficulty);
  if (!kind || !difficulty) return bad;
  let effort: ThinkingLevel | null;
  if (raw.effort === null || raw.effort === undefined) {
    effort = effortForDifficulty(difficulty, cap.thinkingLevels);
  } else if (isThinkingLevel(raw.effort)) {
    effort = clampEffort(raw.effort, cap.thinkingLevels);
  } else {
    return bad;
  }
  if (raw.confidence < config.confidenceThreshold) return { ok: false, reason: "low_confidence" };
  return { ok: true, cap, effort: capEffort(effort, config.maxEffort), mode, kind, difficulty };
}

async function callWithTimeout(
  adapter: DecisionAdapter,
  input: Parameters<DecisionAdapter["decide"]>[0],
  ms: number,
): Promise<RawRouteChoice> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new DecisionError("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([adapter.decide(input, ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function routeTask(req: RouteRequest, deps: RouterDeps): Promise<RouteDecision> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const { config, registry, adapter, cache } = deps;
  const signals = extractSignals(req);
  const cons = resolveConstraints(req, signals, config, registry);
  const pins = req.pins;

  const finish = (d: Draft): RouteDecision => {
    const out: RouteDecision = { ...d, latencyMs: Math.max(0, now() - t0) };
    try {
      deps.log?.(toDiagnostic(out, req, now()));
    } catch {
      // Diagnostics must never break routing.
    }
    return out;
  };

  /** Explicit user pins always win, per dimension. Invalid pins are kept with a warning. */
  const applyPins = (d: Draft): Draft => {
    if (!pins.model && !pins.effort && !pins.executionMode) return d;
    const out = { ...d };
    if (pins.model) {
      const changed = pins.model.provider !== d.provider || pins.model.model !== d.model;
      out.provider = pins.model.provider;
      out.model = pins.model.model;
      if (changed && !pins.effort) {
        const cap = registry.find((c) => c.provider === out.provider && c.model === out.model);
        out.effort = cap
          ? capEffort(effortForDifficulty(d.difficulty, cap.thinkingLevels), config.maxEffort)
          : d.effort;
      }
    }
    if (pins.effort) out.effort = pins.effort;
    if (pins.executionMode) out.executionMode = pins.executionMode;

    const pinnedCap = registry.find((c) => c.provider === out.provider && c.model === out.model);
    const warning = explainPinWarning({
      imageUnsupported: !!pins.model && signals.needsImage && !!pinnedCap && !pinnedCap.vision,
      videoUnsupported: !!pins.model && signals.needsVideo && !!pinnedCap && !pinnedCap.video,
      modeUnavailable:
        pins.executionMode && !cons.allowedModes.includes(pins.executionMode)
          ? pins.executionMode
          : undefined,
    });
    if (warning) {
      out.reason = "pinned_invalid";
      out.explanation = warning;
    } else if (pins.model && pins.effort && pins.executionMode) {
      out.source = "pinned";
      out.reason = "pinned";
      out.explanation = explainReason("pinned");
      out.confidence = 1;
    } else if (pins.model) {
      out.reason = "pinned";
      out.explanation = explainReason("pinned");
    }
    if (pins.model && pins.effort && pins.executionMode) out.source = "pinned";
    return out;
  };

  const currentDraft = (
    reason: RouteReasonCode,
    explanation: string,
    fallbackReason: RouteFallbackReason,
  ): Draft => ({
    provider: req.current.provider,
    model: req.current.model,
    effort: req.current.thinkingLevel,
    executionMode: cons.allowedModes.includes(req.current.executionMode)
      ? req.current.executionMode
      : "standard",
    source: "fallback",
    confidence: 0,
    reason,
    explanation,
    taskKind: signals.taskKind,
    difficulty: signals.difficulty,
    fallbackReason,
  });

  // (0) Feature off: never touch the user's choices.
  if (!config.enabled) {
    return finish(currentDraft("disabled", explainReason("disabled"), "disabled"));
  }

  // (1)+(2) Everything pinned: still evaluated for warnings, never overridden.
  if (pins.model && pins.effort && pins.executionMode) {
    return finish(
      applyPins({
        ...currentDraft("pinned", explainReason("pinned"), "disabled"),
        fallbackReason: undefined,
        source: "pinned",
      }),
    );
  }

  // (1) Hard constraints: no capable candidate → current model, loudly.
  if (cons.candidates.length === 0) {
    return finish(
      applyPins(
        currentDraft(
          cons.unmet === "no_models" ? "auto_unavailable" : "no_capable_model",
          explainConstraintViolation(cons.unmet ?? "no_models"),
          "constraint_violation",
        ),
      ),
    );
  }

  // (3) Cache / follow-up reuse.
  const ttl = config.cacheTtlMs;
  const key = cache ? routeCacheKey(req, signals, config, registry) : null;
  if (cache && key) {
    let hit = cache.get(key);
    if (!hit && signals.isFollowUp) {
      const last = cache.getLast(req.conversation.sessionKey);
      if (
        last &&
        cons.candidates.some((c) => c.provider === last.provider && c.model === last.model) &&
        cons.allowedModes.includes(last.executionMode)
      ) {
        hit = last;
      }
    }
    if (hit) {
      const { latencyMs: _l, ...rest } = hit;
      void _l;
      return finish(
        applyPins({ ...rest, source: "cache", fallbackReason: undefined, usage: undefined }),
      );
    }
  }

  // (4) Decision model, with deterministic fallback.
  let validated: Validated | null = null;
  let fallbackReason: RouteFallbackReason | undefined;
  let raw: RawRouteChoice | undefined;
  if (!adapter) {
    fallbackReason = "no_decision_provider";
  } else {
    try {
      raw = await callWithTimeout(
        adapter,
        buildDecisionInput(req, signals, cons),
        deps.timeoutMs ?? config.timeoutMs,
      );
      validated = validateRaw(raw, cons, config);
      if (!validated.ok) fallbackReason = validated.reason;
    } catch (err) {
      fallbackReason = err instanceof DecisionError ? err.reason : "provider_error";
    }
  }

  const isCurrent = (c: ModelCapability) =>
    c.provider === req.current.provider && c.model === req.current.model;
  let draft: Draft;
  if (validated?.ok) {
    const kept = isCurrent(validated.cap);
    draft = {
      provider: validated.cap.provider,
      model: validated.cap.model,
      effort: validated.effort,
      executionMode: validated.mode,
      source: "router",
      confidence: raw!.confidence,
      reason: deriveReason(validated.mode, signals, validated.kind, validated.difficulty, kept),
      explanation: "",
      taskKind: validated.kind,
      difficulty: validated.difficulty,
      decisionModel: adapter!.label,
      ...(raw!.usage ? { usage: raw!.usage } : {}),
    };
  } else {
    const det = deterministicRoute(req, signals, cons.candidates, cons.allowedModes, config);
    draft = {
      provider: det.capability.provider,
      model: det.capability.model,
      effort: det.effort,
      executionMode: det.executionMode,
      source: "fallback",
      confidence: 0.5,
      reason: deriveReason(
        det.executionMode,
        signals,
        det.taskKind,
        det.difficulty,
        det.keptCurrent,
      ),
      explanation: "",
      taskKind: det.taskKind,
      difficulty: det.difficulty,
      fallbackReason,
      ...(raw?.usage ? { usage: raw.usage } : {}),
    };
  }
  draft.explanation = explainReason(draft.reason);

  if (cache && key && draft.source === "router") {
    const stored: RouteDecision = { ...draft, latencyMs: 0 };
    cache.set(key, stored, ttl);
    cache.setLast(req.conversation.sessionKey, stored, ttl);
  }

  // (5)+(6) Pins over the result, then explanation (set by applyPins when relevant).
  return finish(applyPins(draft));
}
