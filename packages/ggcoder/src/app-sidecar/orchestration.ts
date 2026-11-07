import type { Provider } from "@kenkaiiii/gg-ai";
import { withoutPaidTier } from "@kenkaiiii/gg-core";
import { log } from "../core/logger.js";
import { getModel } from "../core/model-registry.js";
import type { ChildModelPick } from "../core/subagent-manager.js";
import type { WorkerModelPref } from "./app-settings.js";

/**
 * Native orchestration: the Worker model a project's children run on. Pure
 * validation, shared by session start and the `/orchestration/worker-model`
 * route, so both apply the same rules as GG Goals' critters: a known model,
 * a connected provider, never a paid tier (workers run unwatched in parallel).
 */

/** Why a requested Worker model can't be used, or null when it can. */
export function workerPickBlocker(
  target: { provider: Provider; name: string; billing?: { paid?: boolean } } | undefined,
  requested: string,
  providerConnected: boolean,
): { status: 404 | 400; error: string } | null {
  if (!target) return { status: 404, error: `unknown model: ${requested}` };
  if (!providerConnected) {
    return { status: 400, error: `Connect ${target.provider} first to use ${target.name}.` };
  }
  if (target.billing?.paid) {
    return {
      status: 400,
      error: `${target.name} spends real money, so it's only for your main chat. Pick another model for the workers.`,
    };
  }
  return null;
}

/**
 * The pick a persisted pref resolves to at session start, or null (workers
 * follow the orchestrator) when it is stale: model gone from the registry,
 * provider changed, or its provider no longer connected. Logs the reason.
 */
export async function resolveWorkerPick(
  pref: WorkerModelPref | undefined,
  auth: { hasProviderAuth: (provider: Provider) => Promise<boolean> },
): Promise<ChildModelPick | null> {
  if (!pref) return null;
  const model = getModel(pref.model);
  const reason = !model
    ? "model not in the registry"
    : model.provider !== pref.provider
      ? "model moved to another provider"
      : !(await auth.hasProviderAuth(model.provider))
        ? "provider not connected"
        : null;
  if (reason || !model) {
    log("WARN", "app-sidecar", "worker model pin ignored — workers follow the orchestrator", {
      provider: pref.provider,
      model: pref.model,
      reason: reason ?? "unknown",
    });
    return null;
  }
  return { provider: model.provider, model: withoutPaidTier(model.id) };
}

/** The payload the app reads: the pinned worker model id (null: following) and the toggle. */
export function orchestrationStatePayload(ctx: {
  workerModel: ChildModelPick | null;
  session: { isOrchestrate: () => boolean };
}): { workerModel: string | null; orchestrate: boolean } {
  return { workerModel: ctx.workerModel?.model ?? null, orchestrate: ctx.session.isOrchestrate() };
}
