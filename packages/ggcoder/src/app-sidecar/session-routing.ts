import {
  ProviderError,
  classifyProviderError,
  type Message,
  type Provider,
  type ThinkingLevel,
} from "@kenkaiiii/gg-ai";
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
import { hasOrchestrateKeyword } from "../core/orchestration.js";
import { hasUltracodeKeyword } from "../core/ultracode.js";
import { loadOrchestrateDefault, loadUltracodeDefault } from "./app-settings.js";
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

/** The user's own model and reasoning level for a session: what Auto restores when it is turned off. */
export interface RouteBaseline {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
}

export interface AutoRouteSessionState {
  enabled: boolean;
  pins: RoutePins;
  lastDecision: RouteDecisionInfo | null;
  /** Set when Auto first acts (or is enabled), updated by explicit /model and /thinking picks. */
  baseline?: RouteBaseline;
  /** Auto was turned off mid-run; the baseline is restored once the run ends. */
  restorePending?: boolean;
  /** The user flipped Auto in this window; saved-settings changes no longer move it. */
  userToggled?: boolean;
  /** Last saved `enabled` this window saw, so only a real change is followed. */
  savedEnabled?: boolean;
  /** Aborts an in-flight routing decision (Stop). */
  routeAbort?: AbortController;
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

type BaselineCtx = Pick<SessionRouteContext, "session" | "autoRoute">;

/** Remember the user's own model/thinking before Auto changes anything. Idempotent. */
export function ensureBaseline(ctx: BaselineCtx): void {
  if (ctx.autoRoute.baseline) return;
  const st = ctx.session.getState();
  ctx.autoRoute.baseline = {
    provider: st.provider,
    model: st.model,
    thinkingLevel: ctx.session.getThinkingLevel(),
  };
}

/** An explicit /model or /thinking pick while Auto is on becomes the new baseline. */
export function adoptBaseline(ctx: BaselineCtx): void {
  ctx.autoRoute.baseline = undefined;
  ensureBaseline(ctx);
}

/** The model the user chose themselves; what preferences are saved against (never a routed one). */
export function userModelOf(ctx: BaselineCtx): { provider: Provider; model: string } {
  const b = ctx.autoRoute.baseline;
  if (b && ctx.autoRoute.enabled) return { provider: b.provider as Provider, model: b.model };
  const st = ctx.session.getState();
  return { provider: st.provider, model: st.model };
}

/** Put the session back on the user's own model and reasoning level (never persisted). */
export async function restoreBaseline(ctx: SessionRouteContext): Promise<void> {
  const b = ctx.autoRoute.baseline;
  ctx.autoRoute.restorePending = false;
  ctx.autoRoute.baseline = undefined;
  if (!b) return;
  const st = ctx.session.getState();
  if (b.model !== st.model || b.provider !== st.provider) {
    await ctx.session.switchModel(b.provider, b.model, { confirmPaid: true });
    if (!ctx.kenModelOverride) {
      await ctx.syncKenModel(b.provider as never, b.model);
      await ctx.syncKenAutoModel(b.provider as never, b.model);
      ctx.broadcast("ken_model_change", ctx.kenStatePayload());
    }
    ctx.broadcast("extras", ctx.footerExtras());
  }
  const now = ctx.session.getState();
  const level =
    b.thinkingLevel && isThinkingLevelSupported(now.provider, now.model, b.thinkingLevel)
      ? b.thinkingLevel
      : undefined;
  if (level !== ctx.session.getThinkingLevel()) ctx.session.setThinkingLevel(level);
  ctx.broadcast("thinking_change", {
    thinkingLevel: ctx.session.getThinkingLevel() ?? null,
    supportedThinkingLevels: getSupportedThinkingLevels(now.provider, now.model),
  });
}

/**
 * A Settings save changed the saved default. It is the default for NEW windows: a live window
 * follows it only when its own Auto was never toggled by the user and the saved value really
 * changed. Returns whether this window followed.
 */
export async function followSavedAutoDefault(
  ctx: SessionRouteContext,
  enabled: boolean,
): Promise<boolean> {
  const changed = ctx.autoRoute.savedEnabled !== enabled;
  ctx.autoRoute.savedEnabled = enabled;
  if (!changed || ctx.autoRoute.userToggled) return false;
  await setAutoEnabled(ctx, enabled);
  return true;
}

/** Turn Auto on/off for this session. Turning it off returns to the user's own model. */
export async function setAutoEnabled(
  ctx: SessionRouteContext,
  enabled: boolean,
  opts: { byUser?: boolean } = {},
): Promise<void> {
  if (opts.byUser) ctx.autoRoute.userToggled = true;
  ctx.autoRoute.enabled = enabled;
  if (enabled) {
    ensureBaseline(ctx);
    ctx.autoRoute.restorePending = false;
    return;
  }
  if (ctx.running || ctx.runClaim.active) {
    ctx.autoRoute.restorePending = true;
    return;
  }
  await restoreBaseline(ctx);
}

/** Called when a run ends: finish a restore deferred because Auto was turned off mid-run. */
export async function finishPendingRestore(ctx: SessionRouteContext): Promise<void> {
  if (!ctx.autoRoute.restorePending || ctx.autoRoute.enabled) return;
  await restoreBaseline(ctx).catch((err: unknown) =>
    log("WARN", "routing", "restoring the user's model failed", { err: String(err) }),
  );
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
  let abort: AbortController | undefined;
  try {
    ensureBaseline(ctx);
    request = buildRouteRequest(ctx, input);
    const config: AutoRouteConfig = { ...runtime.config(), enabled: true };
    const registry = await runtime.buildRegistry(config);
    abort = new AbortController();
    ctx.autoRoute.routeAbort = abort;
    const decision = await routeTask(request, {
      config,
      registry,
      adapter: null,
      // Built only on a cache miss: a hit needs no credentials or secrets lookup.
      getAdapter: async () => {
        const { adapter, reason } = await runtime.buildAdapter(config);
        return { adapter, reason, secrets: adapter ? await runtime.secrets() : [] };
      },
      signal: abort.signal,
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
  } finally {
    if (abort && ctx.autoRoute.routeAbort === abort) ctx.autoRoute.routeAbort = undefined;
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

function userMessageRecorded(messages: readonly Message[], fromIndex: number): boolean {
  return messages
    .slice(fromIndex)
    .some((m) => m.role === "user" && m.provenance?.visibility !== "hidden");
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
      // Normally the user's message is already in the transcript (AgentSession keeps and
      // persists it when a run fails), so the retry only asks the new model to answer it.
      // If the failure came before it was recorded, send the original prompt again.
      run = userMessageRecorded(ctx.session.getMessages(), before) ? retry : attempt;
    }
  }
}

/** Which execution modes this run switched on, so the user's own setting can be put back after it. */
export interface RunModeFlags {
  ultracode: boolean;
  orchestrate: boolean;
}

export interface PromptRunMeta {
  scheduled?: boolean;
  planRevision?: boolean;
  ultracode?: boolean;
  orchestrate?: boolean;
}

/**
 * Route (when it applies), flip the per-run modes and send the prompt, with bounded escalation.
 * Scheduled and plan-revision prompts are not the user's own and are never routed. Mid-run queued
 * prompts never reach here (they steer the run that is already going). `flags` is filled in so a
 * `finally` can call {@link restoreRunModes} even if the run throws.
 */
export async function runPromptWithRouting(
  ctx: SessionRouteContext,
  input: {
    text: string;
    attachments: AppAttachment[];
    meta: PromptRunMeta | undefined;
    send: () => Promise<void>;
    retry: () => Promise<void>;
  },
  flags: RunModeFlags,
): Promise<void> {
  const { text, meta } = input;
  const codeSession = ctx.mode === "code" && !ctx.goal;
  const userPrompt = meta?.scheduled !== true && meta?.planRevision !== true;
  const typedOrchestrate = codeSession && meta?.orchestrate === true && hasOrchestrateKeyword(text);
  const typedUltracode = codeSession && meta?.ultracode === true && hasUltracodeKeyword(text);
  const keywordMode: ExecutionMode | undefined = typedOrchestrate
    ? "orchestrate"
    : typedUltracode
      ? "ultracode"
      : undefined;
  // A slash command is sent as its short `/name` and expanded inside AgentSession.prompt (async,
  // private to the session), so the router would classify the name, not the body. Keep the
  // current model for those instead of guessing.
  const slashTemplate =
    userPrompt &&
    input.attachments.length === 0 &&
    (await ctx.session.willExpandPromptTemplate(text));
  const routed =
    userPrompt && !slashTemplate
      ? await routeUserPrompt(ctx, { text, attachments: input.attachments, keywordMode })
      : null;
  if (routed?.applied.ultracode) flags.ultracode = true;
  if (routed?.applied.orchestrate) flags.orchestrate = true;
  // "ultracode" / "orchestrate" typed in the prompt: that mode for this run only.
  if (typedUltracode && !ctx.session.isUltracode()) {
    flags.ultracode = true;
    ctx.session.setUltracode(true);
  }
  if (typedOrchestrate && !ctx.session.isOrchestrate()) {
    flags.orchestrate = true;
    ctx.session.setOrchestrate(true);
  }
  const extra = await runWithEscalation(ctx, routed, input.send, input.retry);
  if (extra?.ultracode) flags.ultracode = true;
  if (extra?.orchestrate) flags.orchestrate = true;
}

/** Back to the user's own saved Ultracode/Orchestrate setting (their latest toggle, not this run's). */
export async function restoreRunModes(
  ctx: SessionRouteContext,
  flags: RunModeFlags,
): Promise<void> {
  if (flags.ultracode) ctx.session.setUltracode(await loadUltracodeDefault());
  if (flags.orchestrate) ctx.session.setOrchestrate(await loadOrchestrateDefault());
  flags.ultracode = false;
  flags.orchestrate = false;
  await finishPendingRestore(ctx);
}
