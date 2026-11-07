import type http from "node:http";
import { getModel } from "../core/model-registry.js";
import { log } from "../core/logger.js";
import { saveOrchestrateDefault, saveWorkerModelPref } from "./app-settings.js";
import { readBody, json } from "./http.js";
import { orchestrationStatePayload, workerPickBlocker } from "./orchestration.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * Native orchestration routes for a coding window: pin the Worker model the
 * orchestrator's children run on, and switch Orchestrate on or off. Both are
 * refused for chat, Motion and Goal sessions (Goals has its own critters pick).
 */
export function handleOrchestrationRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method !== "POST" || !url.startsWith("/orchestration/")) return false;
  if (ctx.mode !== "code" || ctx.goal) {
    json(res, 404, { error: "Orchestrate is only available in Israel Code's coding sessions." });
    return true;
  }

  // Pin the Worker model, or clear it (null) so workers follow the orchestrator.
  // Applies to the next child started; running ones keep theirs, so no run lock.
  if (url === "/orchestration/worker-model") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let requested: string | null;
      try {
        const parsed = (JSON.parse(raw) as { model?: unknown } | null)?.model;
        requested = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      try {
        if (requested !== null) {
          const target = getModel(requested);
          const blocked = workerPickBlocker(
            target,
            requested,
            target ? await ctx.auth.hasProviderAuth(target.provider) : false,
          );
          if (blocked || !target) {
            json(res, blocked?.status ?? 404, { error: blocked?.error ?? "unknown model" });
            return;
          }
          ctx.workerModel = { provider: target.provider, model: target.id };
        } else {
          ctx.workerModel = null;
        }
        await saveWorkerModelPref(ctx.cwd, ctx.workerModel);
        const payload = orchestrationStatePayload(ctx);
        log("INFO", "app-sidecar", "worker model set", { model: payload.workerModel ?? "follow" });
        ctx.broadcast("orchestration_state", payload);
        json(res, 200, payload);
      } catch (err) {
        log("ERROR", "app-sidecar", "set worker model failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't change the workers' model" });
      }
    });
    return true;
  }

  // Orchestrate on/off: takes effect with the next message (the hidden notice
  // rides in before it, like Ultracode's) and becomes the new-session default.
  if (url === "/orchestration/toggle") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let on: boolean;
      try {
        on = Boolean((JSON.parse(raw) as { on?: boolean }).on);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      ctx.session.setOrchestrate(on);
      await saveOrchestrateDefault(on);
      log("INFO", "app-sidecar", "orchestrate toggled", { on: String(on) });
      const payload = orchestrationStatePayload(ctx);
      ctx.broadcast("orchestration_state", payload);
      json(res, 200, payload);
    });
    return true;
  }

  return false;
}
