import type http from "node:http";
import { log } from "../core/logger.js";
import {
  normalizeAtTokens,
  normalizePins,
  normalizeThreshold,
  type CompactionPref,
} from "../core/compaction-control.js";
import { saveCompactionPref } from "./app-settings.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * Parse the app's `POST /compaction` body against the current pref: every
 * field is optional; `threshold: null` / `atTokens: null` drop an override.
 * Null when a field is malformed.
 */
function parseCompactionBody(raw: string, current: CompactionPref): CompactionPref | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { threshold?: unknown; atTokens?: unknown; pins?: unknown };
  const next: CompactionPref = { ...current, pins: [...current.pins] };
  if (body.threshold !== undefined) {
    if (body.threshold === null) delete next.threshold;
    else {
      const threshold = normalizeThreshold(body.threshold);
      if (threshold === undefined) return null;
      next.threshold = threshold;
    }
  }
  if (body.atTokens !== undefined) {
    const atTokens = normalizeAtTokens(body.atTokens);
    if (atTokens === undefined) return null;
    next.atTokens = atTokens;
  }
  if (body.pins !== undefined) {
    if (!Array.isArray(body.pins) || !body.pins.every((p) => typeof p === "string")) return null;
    next.pins = normalizePins(body.pins);
  }
  return next;
}

/**
 * Compaction-control routes for a coding window: read the trigger and pins,
 * change them (saved per project in gg-app.json, applied to the live
 * session), compact now, and undo the last compaction. Refused for chat,
 * Motion and Goal sessions.
 */
export function handleCompactionRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (url !== "/compaction" && !url.startsWith("/compaction/")) return false;
  if (method !== "GET" && method !== "POST") return false;
  if (!ctx.compaction || ctx.mode !== "code" || ctx.goal) {
    json(res, 404, {
      error: "Compaction control is only available in Israel Code's coding sessions.",
    });
    return true;
  }
  const compaction = ctx.compaction;

  if (url === "/compaction" && method === "GET") {
    json(res, 200, compaction.statePayload());
    return true;
  }

  if (url === "/compaction" && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const next = parseCompactionBody(raw, compaction.pref);
      if (!next) {
        json(res, 400, {
          error:
            "Send threshold (0.3–0.95 or null), atTokens (≥ 20000 or null) and/or pins (strings, up to 20).",
        });
        return;
      }
      try {
        const saved = await saveCompactionPref(ctx.cwd, next);
        const payload = compaction.setPref(saved);
        log("INFO", "compaction", "compaction settings changed", {
          threshold: String(saved.threshold ?? "default"),
          atTokens: String(saved.atTokens ?? "default"),
          pins: String(saved.pins.length),
        });
        json(res, 200, payload);
      } catch (err) {
        log("ERROR", "compaction", "saving compaction settings failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't save the compaction settings" });
      }
    });
    return true;
  }

  // Compact now, as a run of its own (Stop applies; 409 while a run is active).
  if (url === "/compaction/compact" && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let focus: string | undefined;
      if (raw.trim()) {
        try {
          const body = JSON.parse(raw) as { focus?: unknown };
          if (body.focus !== undefined && typeof body.focus !== "string") throw new Error("focus");
          focus = body.focus?.trim() || undefined;
        } catch {
          json(res, 400, { error: "invalid compact request" });
          return;
        }
      }
      if (ctx.running || ctx.runClaim.active) {
        json(res, 409, { error: "Stop the agent before compacting." });
        return;
      }
      try {
        let outcome = { compacted: false, originalCount: 0, newCount: 0 };
        await ctx.runAgent("Compacting", async () => {
          outcome = await compaction.compactNow(focus);
        });
        json(res, 200, outcome);
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  // Undo: the conversation as it was before the last compaction (404 when none).
  if (url === "/compaction/undo" && method === "POST") {
    if (ctx.running || ctx.runClaim.active) {
      json(res, 409, { error: "Stop the agent before undoing a compaction." });
      return true;
    }
    void compaction
      .undo()
      .then((restored: { restoredCount: number; newCount: number } | null) => {
        if (!restored) {
          json(res, 404, { error: "There is no compaction to undo." });
          return;
        }
        ctx.clearPendingPlan();
        log("INFO", "compaction", "compaction undone", {
          restored: String(restored.restoredCount),
        });
        json(res, 200, restored);
      })
      .catch((err: unknown) => {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }

  return false;
}
