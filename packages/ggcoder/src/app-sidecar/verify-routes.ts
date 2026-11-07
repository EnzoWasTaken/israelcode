import type http from "node:http";
import { log } from "../core/logger.js";
import {
  normalizeMaxRounds,
  normalizeVerifyCommands,
  saveVerifyConfig,
  type VerifyCommandSpec,
} from "../core/verify-loop.js";
import { saveVerifyEnabled } from "./app-settings.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

interface VerifyBody {
  enabled?: boolean;
  commands?: VerifyCommandSpec[];
  maxRounds?: number;
}

/** Parse the app's `POST /verify` body; null when it is malformed. */
function parseVerifyBody(raw: string): VerifyBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { enabled?: unknown; commands?: unknown; maxRounds?: unknown };
  const out: VerifyBody = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return null;
    out.enabled = body.enabled;
  }
  if (body.commands !== undefined) {
    const commands = normalizeVerifyCommands(body.commands);
    if (!commands) return null;
    out.commands = commands;
  }
  if (body.maxRounds !== undefined) {
    const maxRounds = normalizeMaxRounds(body.maxRounds);
    if (maxRounds === undefined) return null;
    out.maxRounds = maxRounds;
  }
  return out;
}

/**
 * Verify-loop routes for a coding window: read the switch and the commands,
 * change them (switch → gg-app.json per project; commands and cap →
 * `<project>/.gg/verify.json`) and run the loop by hand. Refused for chat,
 * Motion and Goal sessions.
 */
export function handleVerifyRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (url !== "/verify" && !url.startsWith("/verify/")) return false;
  if (method !== "GET" && method !== "POST") return false;
  if (!ctx.verify || ctx.mode !== "code" || ctx.goal) {
    json(res, 404, {
      error: "The verify loop is only available in Israel Code's coding sessions.",
    });
    return true;
  }
  const verify = ctx.verify;

  if (url === "/verify" && method === "GET") {
    json(res, 200, verify.statePayload());
    return true;
  }

  if (url === "/verify" && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const body = parseVerifyBody(raw);
      if (!body) {
        json(res, 400, {
          error:
            "Send enabled (true/false), commands (each a label and a command) and/or maxRounds (1–10).",
        });
        return;
      }
      try {
        if (body.enabled !== undefined) {
          await saveVerifyEnabled(ctx.cwd, body.enabled);
          verify.setEnabled(body.enabled);
        }
        if (body.commands !== undefined || body.maxRounds !== undefined) {
          const saved = await saveVerifyConfig(ctx.cwd, {
            commands: body.commands ?? verify.config.commands,
            maxRounds: body.maxRounds ?? verify.config.maxRounds,
          });
          verify.setConfig(saved);
        }
        log("INFO", "verify", "verify settings changed", {
          enabled: String(verify.enabled),
          commands: String(verify.config.commands.length),
          maxRounds: String(verify.config.maxRounds),
        });
        json(res, 200, verify.statePayload());
      } catch (err) {
        log("ERROR", "verify", "saving verify settings failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't save the verify settings" });
      }
    });
    return true;
  }

  // Run the checks now, as a run of its own (Stop applies).
  if (url === "/verify/run" && method === "POST") {
    if (ctx.running || verify.running) {
      json(res, 409, { error: "A run is already in progress" });
      return true;
    }
    void ctx.runAgent("Verify", async () => {
      await verify.start();
    });
    json(res, 200, { started: true });
    return true;
  }

  return false;
}
