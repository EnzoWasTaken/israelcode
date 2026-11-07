import type http from "node:http";
import type { BudgetConfig } from "../core/budget-guard.js";
import { log } from "../core/logger.js";
import { saveBudgetPref } from "./app-settings.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

/** Parse the app's `POST /budget` body; null when it is not a budget. */
function parseBudgetBody(raw: string): BudgetConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as {
    sessionTokens?: unknown;
    dayTokens?: unknown;
    hardStopOnRunaway?: unknown;
  };
  const cap = (value: unknown): number | undefined | null => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  };
  const session = cap(body.sessionTokens);
  const day = cap(body.dayTokens);
  if (session === null || day === null) return null;
  return {
    ...(session !== undefined ? { sessionTokens: session } : {}),
    ...(day !== undefined ? { dayTokens: day } : {}),
    hardStopOnRunaway: body.hardStopOnRunaway !== false,
  };
}

/**
 * Budget guardrail routes for a coding window: read the caps and the meter,
 * set new caps (saved per project, applied to the live session) and continue
 * past a cap the user accepts. Refused for chat, Motion and Goal sessions.
 */
export function handleBudgetRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (url !== "/budget" && !url.startsWith("/budget/")) return false;
  if (method !== "GET" && method !== "POST") return false;
  if (!ctx.budget || ctx.mode !== "code" || ctx.goal) {
    json(res, 404, { error: "Budgets are only available in Israel Code's coding sessions." });
    return true;
  }
  const budget = ctx.budget;

  if (url === "/budget" && method === "GET") {
    json(res, 200, budget.statePayload());
    return true;
  }

  // New caps: saved for the project, applied to this session now (other
  // windows on the project pick them up when their next session starts).
  if (url === "/budget" && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const config = parseBudgetBody(raw);
      if (!config) {
        json(res, 400, { error: "Caps must be whole numbers of tokens above zero, or empty." });
        return;
      }
      try {
        await saveBudgetPref(ctx.cwd, config);
        const payload = budget.configure(config);
        log("INFO", "budget", "budget set", {
          sessionTokens: String(config.sessionTokens ?? "none"),
          dayTokens: String(config.dayTokens ?? "none"),
          hardStopOnRunaway: String(config.hardStopOnRunaway),
        });
        json(res, 200, payload);
      } catch (err) {
        log("ERROR", "budget", "set budget failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't save the budget" });
      }
    });
    return true;
  }

  // "Continue anyway": the caps stop stopping this session until set again.
  if (url === "/budget/continue" && method === "POST") {
    json(res, 200, budget.allowOverride());
    return true;
  }

  return false;
}
