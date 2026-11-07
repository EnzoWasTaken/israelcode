import type http from "node:http";
import { log } from "../core/logger.js";
import { addServer, type MCPScope } from "../core/mcp/index.js";
import type { MCPServerConfig } from "../core/mcp/types.js";
import {
  McpRegistryError,
  getMcpListing,
  listingOptions,
  listingToConfig,
  searchMcpRegistry,
  type McpConfigChoice,
  type McpListing,
} from "../core/mcp-registry.js";
import { collectMcpScanExtras, scanMcpListing } from "../core/mcp-scan.js";
import type { InstallScanResult } from "../core/skill-install-scan.js";
import { readBody, json } from "./http.js";
import { probeMcp } from "./mcp-rows.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * MCP marketplace routes: search the official registry, inspect a listing
 * (run options + static scan, nothing runs) and add one through the same
 * `addServer` path as `/mcp/add`. A blocked scan answers 409 unless the body
 * carries `override: true`, which is logged.
 */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStatus(err: unknown): number {
  if (err instanceof McpRegistryError && err.status === 404) return 404;
  if (err instanceof McpRegistryError) return 502;
  return 500;
}

function parseScope(v: unknown): MCPScope {
  return v === "project" ? "project" : "global";
}

function parseChoice(v: unknown): McpConfigChoice | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as { kind?: unknown; index?: unknown };
  if ((c.kind !== "remote" && c.kind !== "package") || typeof c.index !== "number")
    return undefined;
  return { kind: c.kind, index: c.index };
}

export interface McpMarketOption extends McpConfigChoice {
  label: string;
  config: MCPServerConfig;
  needs: { envNames: string[]; headerNames: string[]; secrets: string[] };
}

async function inspect(
  name: string,
  version: string | undefined,
): Promise<{ listing: McpListing; options: McpMarketOption[]; scan: InstallScanResult }> {
  const listing = await getMcpListing(name, version);
  const options: McpMarketOption[] = [];
  for (const o of listingOptions(listing)) {
    try {
      options.push({ ...o, ...listingToConfig(listing, o) });
    } catch {
      // Unsupported registry type (e.g. mcpb): not offered.
    }
  }
  const extras = await collectMcpScanExtras(listing);
  return { listing, options, scan: scanMcpListing(listing, extras) };
}

export function handleMcpMarketRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url.startsWith("/mcp/market/search")) {
    const params = new URL(url, `http://${ctx.host}`).searchParams;
    void searchMcpRegistry(params.get("q") ?? "", { cursor: params.get("cursor") ?? undefined })
      .then((result) => json(res, 200, result))
      .catch((err) => json(res, errorStatus(err), { servers: [], error: message(err) }));
    return true;
  }

  if (method === "POST" && url === "/mcp/market/inspect") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { name?: string; version?: string };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const name = (body.name ?? "").trim();
      if (!name) {
        json(res, 400, { error: "missing server name" });
        return;
      }
      try {
        json(res, 200, await inspect(name, body.version || undefined));
      } catch (err) {
        json(res, errorStatus(err), { error: message(err) });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/mcp/market/add") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: {
        name?: string;
        version?: string;
        choice?: unknown;
        scope?: string;
        cwd?: string | null;
        values?: { env?: Record<string, string>; headers?: Record<string, string> };
        override?: boolean;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { added: false, error: "invalid JSON body" });
        return;
      }
      const name = (body.name ?? "").trim();
      const choice = parseChoice(body.choice);
      const scope = parseScope(body.scope);
      const targetCwd = body.cwd || ctx.cwd;
      if (!name) {
        json(res, 400, { added: false, error: "missing server name" });
        return;
      }
      if (!choice) {
        json(res, 400, { added: false, error: "missing run option (choice)" });
        return;
      }
      if (scope === "project" && !body.cwd) {
        json(res, 400, { added: false, error: "project scope requires a project (cwd)." });
        return;
      }
      try {
        // Re-fetch and re-scan: the client's copy of the verdict is not trusted.
        const listing = await getMcpListing(name, body.version || undefined);
        const extras = await collectMcpScanExtras(listing);
        const scan = scanMcpListing(listing, extras);
        const override = body.override === true;
        if (scan.verdict === "block" && !override) {
          json(res, 409, { added: false, scan, error: "Blocked by the security scan" });
          return;
        }
        if (scan.verdict === "block") {
          log("WARN", "app-sidecar", "MCP server added despite blocking findings", {
            name: listing.name,
            version: listing.version,
            findings: scan.findings.length,
          });
        }
        const { config } = listingToConfig(listing, choice);
        const env = body.values?.env ?? {};
        const headers = body.values?.headers ?? {};
        if (Object.keys(env).length) config.env = { ...(config.env ?? {}), ...env };
        if (Object.keys(headers).length) config.headers = { ...(config.headers ?? {}), ...headers };
        config.enabled = true;

        // Same path as /mcp/add: best-effort probe, persist, trust the project.
        const probe = await probeMcp(config);
        const saved = await addServer(config, scope, targetCwd, true);
        if (!saved.ok) {
          json(res, 400, { added: false, scan, error: saved.error });
          return;
        }
        if (scope === "project") {
          await ctx.session.trustProject(targetCwd);
        }
        void ctx.trophies.count("mcpServersAdded", ctx.sessionId);
        json(res, 200, {
          added: true,
          name: config.name,
          scan,
          connected: probe.ok,
          toolCount: probe.toolCount,
          error: probe.error,
          requiresAuth: probe.requiresAuth,
        });
      } catch (err) {
        json(res, errorStatus(err), { added: false, error: message(err) });
      }
    });
    return true;
  }

  return false;
}
