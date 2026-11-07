import type http from "node:http";
import { log } from "../core/logger.js";
import { saveHooksConfig } from "../core/hook-presets.js";
import { saveHooksEnabled } from "./app-settings.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

interface HooksBody {
  enabled?: boolean;
  config?: unknown;
}

/** Parse the app's `POST /hooks` body; null when it is malformed. */
function parseHooksBody(raw: string): HooksBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as { enabled?: unknown; config?: unknown };
  const out: HooksBody = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return null;
    out.enabled = body.enabled;
  }
  if (body.config !== undefined) {
    if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) return null;
    out.config = body.config;
  }
  return out;
}

/**
 * Hook-preset routes for a coding window: read the switch, the config, the
 * detected format/lint commands and recent events; change the switch (→
 * gg-app.json per project) and the config (→ `<project>/.gg/hooks.json`).
 * Refused for chat, Motion and Goal sessions.
 */
export function handleHooksRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (url !== "/hooks") return false;
  if (method !== "GET" && method !== "POST") return false;
  if (!ctx.hooks || ctx.mode !== "code" || ctx.goal) {
    json(res, 404, { error: "Hook presets are only available in Israel Code's coding sessions." });
    return true;
  }
  const hooks = ctx.hooks;

  if (method === "GET") {
    json(res, 200, hooks.payload());
    return true;
  }

  void readBody(req, res).then(async (raw) => {
    if (raw === null) return;
    const body = parseHooksBody(raw);
    if (!body) {
      json(res, 400, {
        error: "Send enabled (true/false) and/or config (the hooks.json object).",
      });
      return;
    }
    try {
      if (body.enabled !== undefined) {
        await saveHooksEnabled(ctx.cwd, body.enabled);
        hooks.setEnabled(body.enabled);
      }
      if (body.config !== undefined) {
        hooks.setConfig(await saveHooksConfig(ctx.cwd, body.config));
      }
      log("INFO", "hooks", "hooks settings changed", {
        enabled: String(hooks.enabled),
        custom: String(hooks.config.custom.length),
      });
      json(res, 200, hooks.payload());
    } catch (err) {
      log("ERROR", "hooks", "saving hooks settings failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      json(res, 500, { error: "Couldn't save the hooks settings" });
    }
  });
  return true;
}
