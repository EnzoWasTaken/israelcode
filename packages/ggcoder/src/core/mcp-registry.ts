import type { MCPServerConfig } from "./mcp/types.js";

/**
 * Client for the official MCP Registry (registry.modelcontextprotocol.io).
 * Public, no key. Read-only: it searches and reads listings and turns a
 * listing into an `MCPServerConfig` the existing `addServer` path can save.
 * Nothing here installs or runs a server.
 */

export const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0";
const USER_AGENT = "IsraelCode";
const TIMEOUT_MS = 10_000;

export interface McpListingHeader {
  name: string;
  value?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  description?: string;
}

export interface McpListingRemote {
  type: "streamable-http" | "sse" | string;
  url: string;
  headers?: McpListingHeader[];
}

export interface McpListingArgument {
  type?: "positional" | "named" | string;
  name?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
  description?: string;
}

export interface McpListingPackage {
  registryType: "npm" | "pypi" | "oci" | "nuget" | "mcpb" | string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string; url?: string };
  environmentVariables?: McpListingHeader[];
  packageArguments?: McpListingArgument[];
  runtimeArguments?: McpListingArgument[];
}

export interface McpListing {
  /** Reverse-DNS name, e.g. `io.github.owner/repo`. */
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: { url?: string; source?: string };
  remotes?: McpListingRemote[];
  packages?: McpListingPackage[];
  /** From `_meta["io.modelcontextprotocol.registry/official"]`. */
  status?: "active" | "deprecated" | "deleted" | string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

export interface McpRegistrySearchResult {
  servers: McpListing[];
  nextCursor?: string;
}

export interface McpRegistryOptions {
  limit?: number;
  cursor?: string;
  /** Default true: drop deprecated/deleted and non-latest entries. */
  activeOnly?: boolean;
  fetch?: typeof fetch;
}

export class McpRegistryError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "McpRegistryError";
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function getJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new McpRegistryError(`The MCP registry did not answer in ${TIMEOUT_MS / 1000} s.`);
    }
    throw new McpRegistryError(
      `Couldn't reach the MCP registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) throw new McpRegistryError("Not found in the MCP registry.", 404);
    if (res.status === 429) {
      throw new McpRegistryError("The MCP registry is rate limiting this machine.", 429);
    }
    throw new McpRegistryError(`The MCP registry answered ${res.status}.`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new McpRegistryError("The MCP registry sent something that isn't JSON.");
  }
}

// ── Listing shape ───────────────────────────────────────────────────────────

interface RawEntry {
  server?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toListing(entry: RawEntry): McpListing | undefined {
  const s = entry.server;
  if (!s || typeof s.name !== "string") return undefined;
  const meta = (entry._meta?.[OFFICIAL_META] ?? {}) as Record<string, unknown>;
  const repo = s.repository as { url?: string; source?: string } | undefined;
  return {
    name: s.name,
    title: str(s.title),
    description: str(s.description) ?? "",
    version: str(s.version) ?? "",
    repository:
      repo && typeof repo === "object" ? { url: repo.url, source: repo.source } : undefined,
    remotes: Array.isArray(s.remotes) ? (s.remotes as McpListingRemote[]) : undefined,
    packages: Array.isArray(s.packages) ? (s.packages as McpListingPackage[]) : undefined,
    status: str(meta.status),
    publishedAt: str(meta.publishedAt),
    updatedAt: str(meta.updatedAt),
    isLatest: typeof meta.isLatest === "boolean" ? meta.isLatest : undefined,
  };
}

function isActiveLatest(l: McpListing): boolean {
  return (l.status ?? "active") === "active" && l.isLatest !== false;
}

/** Search the registry. An empty query lists the newest servers. */
export async function searchMcpRegistry(
  query: string,
  opts: McpRegistryOptions = {},
): Promise<McpRegistrySearchResult> {
  const fetchFn = opts.fetch ?? fetch;
  const params = new URLSearchParams();
  const q = query.trim();
  if (q) params.set("search", q);
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 30, 1), 100)));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const data = await getJson<{ servers?: RawEntry[]; metadata?: { nextCursor?: string } }>(
    fetchFn,
    `${MCP_REGISTRY_BASE}/servers?${params.toString()}`,
  );
  let servers = (data.servers ?? []).map(toListing).filter((l): l is McpListing => !!l);
  if (opts.activeOnly !== false) servers = servers.filter(isActiveLatest);
  return { servers, nextCursor: data.metadata?.nextCursor || undefined };
}

/** Read one listing (latest, or a specific version). */
export async function getMcpListing(
  name: string,
  version?: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<McpListing> {
  const fetchFn = opts.fetch ?? fetch;
  const trimmed = name.trim();
  if (!trimmed) throw new McpRegistryError("Missing server name.");
  const base = `${MCP_REGISTRY_BASE}/servers/${encodeURIComponent(trimmed)}`;
  const url = version ? `${base}/versions/${encodeURIComponent(version)}` : base;
  const data = await getJson<RawEntry>(fetchFn, url);
  const listing = toListing(data);
  if (!listing) throw new McpRegistryError(`The registry has no usable entry for "${trimmed}".`);
  return listing;
}

// ── Listing → MCPServerConfig ───────────────────────────────────────────────

export interface McpConfigChoice {
  kind: "remote" | "package";
  index: number;
}

export interface McpConfigNeeds {
  envNames: string[];
  headerNames: string[];
  /** Env or header names marked secret by the listing. */
  secrets: string[];
}

export interface McpListingToConfig {
  config: MCPServerConfig;
  needs: McpConfigNeeds;
}

/** Last path segment of the reverse-DNS name, sanitised to a config key. */
export function serverNameFor(listing: Pick<McpListing, "name">): string {
  const last = listing.name.split("/").pop() ?? listing.name;
  const clean = last
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return clean || "mcp-server";
}

function runtimeFor(pkg: McpListingPackage): string {
  const hint = pkg.runtimeHint?.trim();
  if (hint) return hint;
  switch (pkg.registryType) {
    case "npm":
      return "npx";
    case "pypi":
      return "uvx";
    case "oci":
      return "docker";
    case "nuget":
      return "dnx";
    default:
      return "";
  }
}

function argValues(args: McpListingArgument[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (a.type === "named" && a.name) {
      out.push(a.name);
      const v = a.value ?? a.default;
      if (v) out.push(v);
    } else {
      const v = a.value ?? a.default;
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * Build the config for one run option of a listing. Required env/headers are
 * added with empty (env) or placeholder (header) values for the user to fill.
 */
export function listingToConfig(listing: McpListing, choice: McpConfigChoice): McpListingToConfig {
  const name = serverNameFor(listing);
  const needs: McpConfigNeeds = { envNames: [], headerNames: [], secrets: [] };

  if (choice.kind === "remote") {
    const remote = listing.remotes?.[choice.index];
    if (!remote?.url) throw new McpRegistryError("That listing has no such remote endpoint.");
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      if (!h.name) continue;
      if (h.isRequired) {
        headers[h.name] = h.value ?? "";
        needs.headerNames.push(h.name);
        if (h.isSecret) needs.secrets.push(h.name);
      }
    }
    const config: MCPServerConfig = {
      name,
      url: remote.url,
      transport: remote.type === "sse" ? "sse" : "http",
      enabled: true,
    };
    if (Object.keys(headers).length) config.headers = headers;
    return { config, needs };
  }

  const pkg = listing.packages?.[choice.index];
  if (!pkg?.identifier) throw new McpRegistryError("That listing has no such package.");
  const runtime = runtimeFor(pkg);
  if (!runtime) {
    throw new McpRegistryError(
      `Israel Code can't run "${pkg.registryType}" packages yet. Pick another option.`,
    );
  }
  const spec =
    pkg.version && pkg.registryType === "npm" ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  let args: string[];
  const runtimeArgs = argValues(pkg.runtimeArguments);
  switch (runtime) {
    case "npx":
      args = ["-y", ...runtimeArgs, spec];
      break;
    case "docker":
      args = ["run", "-i", "--rm", ...runtimeArgs, pkg.identifier];
      break;
    default:
      args = [...runtimeArgs, spec];
  }
  args.push(...argValues(pkg.packageArguments));

  const env: Record<string, string> = {};
  for (const e of pkg.environmentVariables ?? []) {
    if (!e.name) continue;
    env[e.name] = e.isRequired ? "" : (e.value ?? "");
    if (e.isRequired) needs.envNames.push(e.name);
    if (e.isSecret) needs.secrets.push(e.name);
  }
  const config: MCPServerConfig = { name, command: runtime, args, enabled: true };
  if (Object.keys(env).length) config.env = env;
  return { config, needs };
}

/** Every run option of a listing, with a short label for a picker. */
export function listingOptions(listing: McpListing): Array<McpConfigChoice & { label: string }> {
  const out: Array<McpConfigChoice & { label: string }> = [];
  (listing.remotes ?? []).forEach((r, index) => {
    out.push({ kind: "remote", index, label: `Remote (${r.type}) ${r.url}` });
  });
  (listing.packages ?? []).forEach((p, index) => {
    out.push({ kind: "package", index, label: `${p.registryType}: ${p.identifier}` });
  });
  return out;
}
