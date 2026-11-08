import { ProviderError, classifyProviderError, type Message } from "@kenkaiiii/gg-ai";
import { getModel } from "../core/model-registry.js";
import { isModelUnavailableFailure } from "../core/model-unavailable.js";
import { log } from "../core/logger.js";
import { getSupportedThinkingLevels, isThinkingLevelSupported } from "../core/thinking-level.js";
import {
  nextEscalation,
  routeTask,
  toDiagnostic,
  type AutoRouteConfig,
  type EscalationFailure,
  type ExecutionMode,
  type ModelCapability,
  type RouteAttachment,
  type RouteDecision,
  type RoutePins,
  type RouteRequest,
} from "../core/routing/index.js";
import type { AppAttachment } from "./attachments.js";
import type { SessionRouteContext } from "./route-context.js";

/** Content-free summary of a decision, as shown in the app and stored in the transcript. */
export interface RouteDecisionInfo {
  provider: string;
  model: string;
  modelName: string;
  effort: string | null;
  executionMode: ExecutionMode;
  source: RouteDecision["source"];
  reason: RouteDecision["reason"];
  explanation: string;
  confidence: number;
  fallbackReason: string | null;
  latencyMs: number;
}

export interface AutoRouteSessionState {
  enabled: boolean;
  pins: RoutePins;
  lastDecision: RouteDecisionInfo | null;
}

export const AUTO_UNAVAILABLE_EXPLANATION = "Auto routing unavailable — using your current model";

/** Auto applies to code and chat windows only; motion and goal windows keep their own model policy. */
export function autoRouteAvailability(
  ctx: Pick<SessionRouteContext, "mode" | "goal">,
): { available: true } | { available: false; reason: string } {
  if (ctx.mode === "motion") {
    return { available: false, reason: "Auto routing isn't used in Motion." };
  }
  if (ctx.goal) {
    return { available: false, reason: "Goal windows use their own model settings." };
  }
  return { available: true };
}

export function autoRoutePayload(
  ctx: Pick<SessionRouteContext, "mode" | "goal" | "autoRoute">,
): Record<string, unknown> {
  const avail = autoRouteAvailability(ctx);
  return {
    enabled: avail.available && ctx.autoRoute.enabled,
    pins: ctx.autoRoute.pins,
    lastDecision: ctx.autoRoute.lastDecision,
    available: avail.available,
    ...(avail.available ? {} : { reason: avail.reason }),
  };
}

export function toDecisionInfo(d: RouteDecision): RouteDecisionInfo {
  return {
    provider: d.provider,
    model: d.model,
    modelName: getModel(d.model)?.name ?? d.model,
    effort: d.effort,
    executionMode: d.executionMode,
    source: d.source,
    reason: d.reason,
    explanation: d.explanation,
    confidence: d.confidence,
    fallbackReason: d.fallbackReason ?? null,
    latencyMs: d.latencyMs,
  };
}

export function attachmentKind(a: Pick<AppAttachment, "kind" | "mediaType">): RouteAttachment {
  const mime = a.mediaType;
  if (a.kind === "image") return { kind: "image", mime };
  if (a.kind === "video") return { kind: "video", mime };
  if (mime.startsWith("audio/")) return { kind: "audio", mime };
  if (mime === "application/pdf" || mime.startsWith("text/")) return { kind: "document", mime };
  return { kind: "other", mime };
}

function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .flatMap((p) => ("text" in p && typeof p.text === "string" ? [p.text] : []))
    .join("\n");
}

export function currentExecutionMode(
  session: Pick<SessionRouteContext["session"], "isUltracode" | "isOrchestrate">,
): ExecutionMode {
  if (session.isOrchestrate()) return "orchestrate";
  if (session.isUltracode()) return "ultracode";
  return "standard";
}

export function buildRouteRequest(
  ctx: SessionRouteContext,
  input: { text: string; attachments: AppAttachment[]; keywordMode?: ExecutionMode },
): RouteRequest {
  const messages = ctx.session.getMessages();
  const userTexts = messages
    .filter((m) => m.role === "user" && m.provenance?.visibility !== "hidden")
    .map((m) => messageText(m).slice(0, 300))
    .filter(Boolean);
  const st = ctx.session.getState();
  const mode = currentExecutionMode(ctx.session);
  // The user's own toggles and typed keywords are explicit choices, so they pin the mode.
  const pinnedMode =
    ctx.autoRoute.pins.executionMode ??
    input.keywordMode ??
    (mode === "standard" ? undefined : mode);
  return {
    text: input.text,
    attachments: input.attachments.map(attachmentKind),
    workspace: ctx.mode,
    isGoal: ctx.goal !== null,
    hasSpawnAgent: ctx.mode === "code" && ctx.goal === null,
    conversation: {
      sessionKey: ctx.sessionId,
      turns: userTexts.length,
      estimatedTokens: ctx.session.getContextUsage().used,
      recentUserTexts: userTexts.slice(-2),
      historyHasImages: messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"),
      ),
    },
    current: {
      provider: st.provider,
      model: st.model,
      thinkingLevel: ctx.session.getThinkingLevel() ?? null,
      executionMode: mode,
    },
    pins: { ...ctx.autoRoute.pins, ...(pinnedMode ? { executionMode: pinnedMode } : {}) },
  };
}

/** What a routed prompt changed for this run only, so the caller can restore the user's own settings. */
export interface AppliedRoute {
  ultracode: boolean;
  orchestrate: boolean;
}

/** Switch model / thinking / mode for this run. Never persisted as the user's preference. */
export async function applyDecision(
  ctx: SessionRouteContext,
  d: RouteDecision,
): Promise<AppliedRoute> {
  const applied: AppliedRoute = { ultracode: false, orchestrate: false };
  const st = ctx.session.getState();
  const target = getModel(d.model);
  // Paid tiers are never switched to implicitly (no confirmPaid is ever passed).
  const blockedPaid = target?.billing?.paid === true && d.model !== st.model;
  if (target && !blockedPaid && (d.model !== st.model || d.provider !== st.provider)) {
    await ctx.session.switchModel(d.provider, d.model);
    if (!ctx.kenModelOverride) {
      await ctx.syncKenModel(d.provider as never, d.model);
      await ctx.syncKenAutoModel(d.provider as never, d.model);
    }
    ctx.broadcast("extras", ctx.footerExtras());
  }
  const now = ctx.session.getState();
  const prev = ctx.session.getThinkingLevel();
  let level = d.effort ?? prev;
  if (level && !isThinkingLevelSupported(now.provider, now.model, level)) {
    level = undefined;
  }
  if (level !== prev) ctx.session.setThinkingLevel(level);
  ctx.broadcast("thinking_change", {
    thinkingLevel: ctx.session.getThinkingLevel() ?? null,
    supportedThinkingLevels: getSupportedThinkingLevels(now.provider, now.model),
  });

  if (d.executionMode === "ultracode" && !ctx.session.isUltracode()) {
    ctx.session.setUltracode(true);
    applied.ultracode = true;
  } else if (d.executionMode === "orchestrate" && !ctx.session.isOrchestrate()) {
    ctx.session.setOrchestrate(true);
    applied.orchestrate = true;
  }
  return applied;
}

export function publishDecision(ctx: SessionRouteContext, d: RouteDecision): void {
  const info = toDecisionInfo(d);
  ctx.autoRoute.lastDecision = info;
  ctx.broadcast("route_decision", info);
  void ctx.session
    .persistAppMarker("route_decision", { ...info }, 1)
    .catch((err: unknown) => log("DEBUG", "routing", "route marker failed", { err: String(err) }));
}

export interface RoutedRun {
  decision: RouteDecision;
  request: RouteRequest;
  registry: ModelCapability[];
  config: AutoRouteConfig;
  applied: AppliedRoute;
}

/**
 * Decide and apply the route for a user prompt. Never throws: any failure runs the prompt on the
 * current configuration with a visible "unavailable" decision.
 */
export async function routeUserPrompt(
  ctx: SessionRouteContext,
  input: { text: string; attachments: AppAttachment[]; keywordMode?: ExecutionMode },
): Promise<RoutedRun | null> {
  if (!ctx.autoRoute.enabled || !autoRouteAvailability(ctx).available) return null;
  const runtime = ctx.routing;
  let request: RouteRequest | null = null;
  try {
    request = buildRouteRequest(ctx, input);
    const config: AutoRouteConfig = { ...runtime.config(), enabled: true };
    const registry = await runtime.buildRegistry(config);
    const { adapter } = await runtime.buildAdapter(config);
    const decision = await routeTask(request, {
      config,
      registry,
      adapter,
      cache: runtime.cache,
      log: (e) => runtime.diagnostics.record(e),
    });
    const applied = await applyDecision(ctx, decision);
    publishDecision(ctx, decision);
    return { decision, request, registry, config, applied };
  } catch (err) {
    log("WARN", "routing", "auto routing failed; using current model", {
      message: err instanceof Error ? err.message : String(err),
    });
    const st = ctx.session.getState();
    const fallback: RouteDecision = {
      provider: st.provider,
      model: st.model,
      effort: ctx.session.getThinkingLevel() ?? null,
      executionMode: currentExecutionMode(ctx.session),
      source: "fallback",
      confidence: 0,
      reason: "auto_unavailable",
      explanation: AUTO_UNAVAILABLE_EXPLANATION,
      taskKind: "conversation",
      difficulty: "simple",
      fallbackReason: "provider_error",
      latencyMs: 0,
    };
    try {
      if (request) runtime.diagnostics.record(toDiagnostic(fallback, request));
      publishDecision(ctx, fallback);
    } catch {
      // Routing must never block the prompt.
    }
    return null;
  }
}

/** A provider failure worth retrying on a different model, or null (auth, billing, bugs, aborts). */
export function classifyEscalation(err: unknown): EscalationFailure | null {
  const message = err instanceof Error ? err.message : String(err);
  if (isModelUnavailableFailure(err)) return { kind: "model_error" };
  if (err instanceof ProviderError && err.statusCode === 429) return { kind: "rate_limited" };
  const tag = /^\[(\w+)\]/.exec(classifyProviderError(message))?.[1];
  if (tag === "context_overflow") return { kind: "context_overflow" };
  if (tag === "rate_limited") return { kind: "rate_limited" };
  if (tag === "provider_transient") return { kind: "provider_unavailable" };
  return null;
}

/** Whether the failed run already produced assistant output or tool calls (a retry could duplicate them). */
export function runProducedOutput(messages: readonly Message[], fromIndex: number): boolean {
  return messages.slice(fromIndex).some((m) => {
    if (m.role === "tool") return true;
    if (m.role !== "assistant") return false;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    return m.content.some(
      (p) => p.type === "tool_call" || (p.type === "text" && p.text.trim().length > 0),
    );
  });
}

export const ESCALATION_RETRY_NOTE =
  "The previous attempt could not run (the model was unavailable). Please answer the user's last message above.";

/**
 * Run `attempt`; on a classified provider failure with nothing produced yet, escalate (bounded by
 * `config.escalation.maxAttempts`) and retry via `retry`. Otherwise rethrow the original error.
 */
export async function runWithEscalation(
  ctx: SessionRouteContext,
  routed: RoutedRun | null,
  attempt: () => Promise<void>,
  retry: () => Promise<void>,
): Promise<AppliedRoute | null> {
  const before = ctx.session.getMessages().length;
  let extra = null as AppliedRoute | null;
  let prev = routed?.decision ?? null;
  let n = 0;
  let run = attempt;
  for (;;) {
    try {
      await run();
      return extra;
    } catch (err) {
      const failure = routed && prev ? classifyEscalation(err) : null;
      if (!routed || !prev || !failure) throw err;
      if (runProducedOutput(ctx.session.getMessages(), before)) throw err;
      n += 1;
      const next = nextEscalation(prev, failure, n, {
        config: routed.config,
        registry: routed.registry,
        request: routed.request,
      });
      if (!next) throw err;
      log("INFO", "routing", "escalating after provider failure", { kind: failure.kind });
      const applied = await applyDecision(ctx, next);
      extra = {
        ultracode: (extra?.ultracode ?? false) || applied.ultracode,
        orchestrate: (extra?.orchestrate ?? false) || applied.orchestrate,
      };
      ctx.routing.diagnostics.record(toDiagnostic(next, routed.request));
      publishDecision(ctx, next);
      prev = next;
      run = retry;
    }
  }
}
