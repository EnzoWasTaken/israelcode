import type http from "node:http";
import type { AuthStorage, OAuthCredentials } from "@kenkaiiii/gg-core";
import { getModel } from "../core/model-registry.js";
import { log } from "../core/logger.js";
import {
  autoRouteConfigSchema,
  parseAutoRouteConfig,
  routeTask,
  type AutoRouteConfig,
  type RouteFallbackReason,
  type RoutePins,
  type RouteRequest,
} from "../core/routing/index.js";
import { isThinkingLevel } from "../core/routing/capabilities.js";
import type { RoutingRuntime } from "./routing-runtime.js";
import { maskKey } from "./routing-runtime.js";
import type { SessionRouteContext } from "./route-context.js";
import { autoRouteAvailability, autoRoutePayload, setAutoEnabled } from "./session-routing.js";

export interface RoutingRouteDeps {
  runtime: RoutingRuntime;
  auth: AuthStorage;
  readBody: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<string | null>;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Tell every window that a provider credential changed. */
  broadcastAll?: (type: string, data: unknown) => void;
}

const TEST_TIMEOUT_MS = 10_000;
export const KEY_MIN = 8;
export const KEY_MAX = 400;

/** Printable ASCII without spaces, a sane length. Returns a readable problem or null. */
export function checkKeyShape(key: string): string | null {
  if (key.length < KEY_MIN) return "That key looks too short.";
  if (key.length > KEY_MAX) return "That key looks too long.";
  if (!/^[\x21-\x7e]+$/.test(key)) return "Keys can't contain spaces or special characters.";
  return null;
}

/** Plain-language test failure. Never includes the key or the provider's raw body. */
export function describeTestFailure(reason: RouteFallbackReason, status: number | null): string {
  if (status === 401 || status === 403) return `The key was rejected (${status})`;
  if (status === 402) return "No credits on the account (402)";
  if (status === 404) return "The decision model wasn't found (404)";
  if (status === 429 || reason === "rate_limited") return "Rate limited, try again shortly";
  if (status !== null && status >= 500)
    return `The service had a problem (${status}), try again shortly`;
  switch (reason) {
    case "missing_credentials":
      return status === null
        ? "No API key or sign-in is saved for the decision model. Add one first"
        : "The key was rejected";
    case "timeout":
      return "The decision model took too long to answer";
    case "invalid_output":
      return "The decision model answered in a format Auto couldn't use";
    case "no_decision_provider":
      return "No decision model is selected or it can't be used";
    case "constraint_violation":
      return "No connected model is available to route to. Sign in to a provider first";
    default:
      return "The decision model couldn't be reached";
  }
}

/** Structural problems with a submitted config (empty = OK). */
export function configProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["The routing settings are missing or not an object."];
  }
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  if ("enabled" in o && typeof o.enabled !== "boolean")
    problems.push("'enabled' must be on or off.");
  if (o.decider !== undefined && o.decider !== null) {
    const parsed = autoRouteConfigSchema.shape.decider.safeParse(o.decider);
    if (!parsed.success || parsed.data === null)
      problems.push("The decision model choice is invalid.");
  }
  if (o.maxEffort !== undefined && o.maxEffort !== null && !isThinkingLevel(o.maxEffort)) {
    problems.push("The maximum effort level is invalid.");
  }
  if (o.candidateModels !== undefined && o.candidateModels !== null) {
    if (!Array.isArray(o.candidateModels) || o.candidateModels.some((m) => typeof m !== "string")) {
      problems.push("The model allow-list must be a list of model ids.");
    } else {
      for (const m of o.candidateModels as string[]) {
        const id = m.includes(":") ? m.slice(m.indexOf(":") + 1) : m;
        if (!getModel(id)) problems.push(`Unknown model in the allow-list: ${m}`);
      }
    }
  }
  return problems;
}

/** Pins in a session request: unknown models or bad levels are rejected. */
export function pinProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return ["Pins must be an object."];
  const p = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (p.model !== undefined) {
    const m = p.model as { provider?: unknown; model?: unknown } | null;
    if (!m || typeof m.provider !== "string" || typeof m.model !== "string") {
      problems.push("The pinned model is invalid.");
    } else {
      const info = getModel(m.model);
      if (!info || info.provider !== m.provider) problems.push(`Unknown model: ${m.model}`);
    }
  }
  if (p.effort !== undefined && !isThinkingLevel(p.effort))
    problems.push("The pinned effort is invalid.");
  if (
    p.executionMode !== undefined &&
    p.executionMode !== "standard" &&
    p.executionMode !== "ultracode" &&
    p.executionMode !== "orchestrate"
  ) {
    problems.push("The pinned execution mode is invalid.");
  }
  return problems;
}

async function configPayload(runtime: RoutingRuntime) {
  const config = runtime.config();
  return {
    config,
    problems: await runtime.validate(config),
    credentials: await runtime.credentialStatus(),
    deciderOptions: await runtime.deciderOptions(),
  };
}

async function runTest(deps: RoutingRouteDeps) {
  const { runtime } = deps;
  const config: AutoRouteConfig = { ...runtime.config(), enabled: true, cacheTtlMs: 0 };
  const built = await runtime.buildAdapter(config);
  const decider = built.adapter?.label ?? config.decider?.model ?? "none";
  if (!built.adapter) {
    const reason = built.reason ?? "no_decision_provider";
    return {
      ok: false,
      latencyMs: 0,
      decider,
      error: { reason, message: describeTestFailure(reason, null) },
    };
  }
  const registry = await runtime.buildRegistry(config);
  const first = registry[0];
  if (!first) {
    return {
      ok: false,
      latencyMs: 0,
      decider,
      error: {
        reason: "constraint_violation" as const,
        message: describeTestFailure("constraint_violation", null),
      },
    };
  }
  const request: RouteRequest = {
    text: "Rename the variable `tmp` to `total` in a small helper function.",
    attachments: [],
    workspace: "code",
    isGoal: false,
    hasSpawnAgent: true,
    conversation: { sessionKey: "routing-test", turns: 0, estimatedTokens: 0 },
    current: {
      provider: first.provider,
      model: first.model,
      thinkingLevel: null,
      executionMode: "standard",
    },
    pins: {},
  };
  const t0 = Date.now();
  const decision = await routeTask(request, {
    config,
    registry,
    adapter: built.adapter,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  const latencyMs = Date.now() - t0;
  const reason = decision.fallbackReason;
  // A low-confidence answer still proves the service works.
  if (reason && reason !== "low_confidence") {
    // A model decider reports a rejected login as missing_credentials with no HTTP status.
    const status = built.lastStatus() ?? (reason === "missing_credentials" ? 401 : null);
    return {
      ok: false,
      latencyMs,
      decider,
      error: { reason, message: describeTestFailure(reason, status) },
    };
  }
  return {
    ok: true,
    latencyMs,
    decider,
    sample: {
      model: decision.model,
      effort: decision.effort,
      executionMode: decision.executionMode,
      confidence: decision.confidence,
    },
  };
}

/** Daemon-level routes: Settings can be open with no window session. */
export function handleRoutingRoutes(
  deps: RoutingRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  const { runtime, auth, json } = deps;
  const fail = (err: unknown) => {
    log("WARN", "routing", "route failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, { error: "Auto routing request failed — see the sidecar log." });
  };

  if (method === "GET" && url === "/routing/config") {
    void configPayload(runtime).then((p) => json(res, 200, p), fail);
    return true;
  }

  if (method === "POST" && url === "/routing/config") {
    void deps.readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      try {
        let body: { config?: unknown };
        try {
          body = JSON.parse(raw) as { config?: unknown };
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const problems = configProblems(body.config);
        if (problems.length > 0) {
          json(res, 400, { error: problems.join(" "), problems });
          return;
        }
        await runtime.setConfig(parseAutoRouteConfig(body.config));
        json(res, 200, await configPayload(runtime));
      } catch (err) {
        fail(err);
      }
    });
    return true;
  }

  if (method === "POST" && url === "/routing/credential") {
    void deps.readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      try {
        let body: { service?: unknown; apiKey?: unknown; replace?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (body.service !== "typesafe" && body.service !== "openrouter") {
          json(res, 400, { error: "Unknown service." });
          return;
        }
        const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const shape = checkKeyShape(key);
        if (shape) {
          json(res, 400, { error: shape });
          return;
        }
        const existing = await auth.getCredentials(body.service);
        if (body.service === "openrouter" && existing?.accessToken && body.replace !== true) {
          json(res, 409, {
            error:
              "An OpenRouter key is already saved (it's the same one your OpenRouter sign-in uses). Replace it only if you mean to.",
            exists: true,
            masked: maskKey(existing.accessToken),
          });
          return;
        }
        const creds: OAuthCredentials = {
          accessToken: key,
          refreshToken: "",
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100,
        };
        await auth.setCredentials(body.service, creds);
        if (body.service === "openrouter") {
          deps.broadcastAll?.("auth_change", { provider: "openrouter" });
          deps.broadcastAll?.("models_change", {});
        }
        json(res, 200, { ok: true, service: body.service, set: true, masked: maskKey(key) });
      } catch (err) {
        fail(err);
      }
    });
    return true;
  }

  if (method === "DELETE" && url === "/routing/credential/typesafe") {
    void auth
      .clearCredentials("typesafe")
      .then(() => json(res, 200, { ok: true, set: false, masked: null }), fail);
    return true;
  }

  if (method === "POST" && url === "/routing/test") {
    void deps.readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      try {
        json(res, 200, await runTest(deps));
      } catch (err) {
        fail(err);
      }
    });
    return true;
  }

  if (method === "GET" && url === "/routing/diagnostics") {
    void runtime.diagnostics
      .recent(50)
      .then((diagnostics) => json(res, 200, { diagnostics }), fail);
    return true;
  }

  return false;
}

/** Session-level: this window's on/off and pins. */
export function handleRoutingSessionRoute(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  readBody: RoutingRouteDeps["readBody"],
  json: RoutingRouteDeps["json"],
): boolean {
  if (!(method === "POST" && url === "/routing/session")) return false;
  void readBody(req, res).then(async (raw) => {
    if (raw === null) return;
    let body: { enabled?: unknown; pins?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }
    const avail = autoRouteAvailability(ctx);
    if (!avail.available) {
      json(res, 409, { error: avail.reason, ...autoRoutePayload(ctx) });
      return;
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      json(res, 400, { error: "'enabled' must be true or false." });
      return;
    }
    let pins: RoutePins | undefined;
    if (body.pins !== undefined) {
      if (body.pins === null) {
        pins = {};
      } else {
        const problems = pinProblems(body.pins);
        if (problems.length > 0) {
          json(res, 400, { error: problems.join(" "), problems });
          return;
        }
        const p = body.pins as RoutePins;
        pins = {
          ...(p.model ? { model: { provider: p.model.provider, model: p.model.model } } : {}),
          ...(p.effort ? { effort: p.effort } : {}),
          ...(p.executionMode ? { executionMode: p.executionMode } : {}),
        };
      }
    }
    if (pins) ctx.autoRoute.pins = pins;
    if (typeof body.enabled === "boolean") {
      try {
        // Turning Auto off returns the window to the user's own model and reasoning level.
        await setAutoEnabled(ctx, body.enabled);
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    const payload = autoRoutePayload(ctx);
    ctx.broadcast("route_state", payload);
    json(res, 200, payload);
  });
  return true;
}
