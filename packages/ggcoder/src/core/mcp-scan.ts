import type { McpListing, McpListingArgument, McpListingPackage } from "./mcp-registry.js";
import {
  scanSkillSnapshotFiles,
  summarizeFindings,
  verdictFor,
  type InstallScanFinding,
  type InstallScanResult,
  type InstallScanSeverity,
} from "./skill-install-scan.js";
import { isExfilUrl, isSuspiciousSkillInstallUrl } from "./skill-scan.js";

/**
 * Static security scan of an MCP registry listing (marketplace side).
 *
 * Looks at the listing itself and, when the caller fetched them, the npm/PyPI
 * package metadata and the repository README. Never installs or runs the
 * server. Rules MCP-01..MCP-10 are this file's; MCP-09/MCP-10 reuse the skill
 * scanner's text rules by feeding it the description and README as synthetic
 * Markdown files, so prompt-injection, hidden-text and curl|sh patterns come
 * from the same catalogue the Skills page uses.
 *
 * Verdict: any critical/high finding → "block"; medium → "warn"; else "pass".
 */

export const MCP_SCAN_RULES: Readonly<
  Record<string, { title: string; severity: InstallScanSeverity }>
> = {
  "MCP-01": { title: "Listing is deprecated or deleted", severity: "medium" },
  "MCP-02": {
    title: "Remote endpoint is not https, or is on a raw IP / paste / tunnel host",
    severity: "high",
  },
  "MCP-03": { title: "Package name looks like a typo of a well-known server", severity: "medium" },
  "MCP-04": { title: "npm package runs install scripts", severity: "high" },
  "MCP-05": { title: "Package is very new or has little history", severity: "low" },
  "MCP-06": {
    title: "Arguments contain shell metacharacters or download-and-run",
    severity: "critical",
  },
  "MCP-07": { title: "Asks for broad credentials", severity: "low" },
  "MCP-08": {
    title: "Repository host unusual or does not match the listing owner",
    severity: "medium",
  },
  "MCP-09": { title: "Prompt injection or hidden text in description / README", severity: "high" },
  "MCP-10": { title: "README installs by piping a download into a shell", severity: "critical" },
};
const RULE_COUNT = Object.keys(MCP_SCAN_RULES).length;

export interface McpScanExtras {
  readme?: string;
  npmMeta?: unknown;
  pypiMeta?: unknown;
  /** Plain-words notes for checks that could not run ("Could not check X"). */
  unavailable?: string[];
}

const USER_AGENT = "IsraelCode";
const TIMEOUT_MS = 10_000;
const MAX_README_CHARS = 200_000;

/** Well-known server names a typosquat would imitate. */
const KNOWN_PACKAGES = [
  "@modelcontextprotocol/server-filesystem",
  "@modelcontextprotocol/server-github",
  "@modelcontextprotocol/server-memory",
  "@modelcontextprotocol/server-fetch",
  "@modelcontextprotocol/server-everything",
  "@modelcontextprotocol/server-sequential-thinking",
  "@modelcontextprotocol/server-puppeteer",
  "@modelcontextprotocol/server-brave-search",
  "@modelcontextprotocol/server-slack",
  "@modelcontextprotocol/server-postgres",
  "@modelcontextprotocol/server-sqlite",
  "@modelcontextprotocol/server-google-maps",
  "@playwright/mcp",
  "@notionhq/notion-mcp-server",
  "@supabase/mcp-server-supabase",
  "@upstash/context7-mcp",
  "@sentry/mcp-server",
  "@stripe/mcp",
  "@anthropic-ai/mcp",
  "firecrawl-mcp",
  "mcp-server-fetch",
  "mcp-server-git",
  "mcp-server-time",
  "mcp-server-sqlite",
  "mcp-server-kubernetes",
  "mcp-server-docker",
  "mcp-server-chrome",
];

const BROAD_CREDENTIAL_ENV =
  /^(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|SSH_PRIVATE_KEY|SSH_KEY|ID_RSA|PRIVATE_KEY|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|NPM_TOKEN|DOCKER_PASSWORD|KUBECONFIG|SUDO_PASSWORD|ROOT_PASSWORD)$/i;

const SHELL_META = /[;&|`$<>]|\$\(|\brm\s+-rf\b/;
const DOWNLOAD_RUN =
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(ba|z|da|k)?sh\b|\b(curl|wget)\b[^\n]*\|\s*(bash|sh|python|node|perl|pwsh|powershell)\b/i;
const REPO_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i;

class Findings {
  readonly list: InstallScanFinding[] = [];
  add(rule: string, file: string, reason: string, evidence?: string, line = 0): void {
    const def = MCP_SCAN_RULES[rule];
    if (!def) return;
    this.list.push({
      rule,
      title: def.title,
      severity: def.severity,
      file,
      line,
      reason,
      evidence: evidence ? evidence.slice(0, 160) : undefined,
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The well-known name this identifier is 1–2 edits away from, if any. */
export function typosquatOf(identifier: string): string | undefined {
  const id = identifier.toLowerCase();
  for (const known of KNOWN_PACKAGES) {
    if (id === known) return undefined;
    const d = editDistance(id, known);
    if (d >= 1 && d <= 2) return known;
    // Same bare name under a different (unofficial) scope.
    const bare = known.split("/").pop()!;
    const idBare = id.split("/").pop()!;
    if (known.startsWith("@") && id.startsWith("@") && idBare === bare && id !== known)
      return known;
  }
  return undefined;
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function ownerOf(listingName: string): string | undefined {
  // io.github.owner/repo → owner ; ai.smithery/x → undefined
  const m = /^io\.github\.([^/]+)\//i.exec(listingName);
  return m?.[1]?.toLowerCase();
}

function argStrings(args: McpListingArgument[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    for (const v of [a.name, a.value, a.default]) if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

// ── npm / pypi metadata readers ─────────────────────────────────────────────

interface NpmSummary {
  scripts: Record<string, string>;
  created?: string;
  versions: number;
  maintainers: number;
}

function readNpmMeta(raw: unknown, pkg: McpListingPackage): NpmSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;
  const distTags = (meta["dist-tags"] ?? {}) as Record<string, string>;
  const versions = (meta.versions ?? {}) as Record<string, Record<string, unknown>>;
  const chosen = (pkg.version && versions[pkg.version]) || versions[distTags.latest ?? ""];
  const scripts = (chosen?.scripts ?? {}) as Record<string, string>;
  const time = (meta.time ?? {}) as Record<string, string>;
  const maintainers = Array.isArray(meta.maintainers) ? meta.maintainers.length : 0;
  return {
    scripts: typeof scripts === "object" && scripts ? scripts : {},
    created: time.created,
    versions: Object.keys(versions).length,
    maintainers,
  };
}

function readPypiMeta(raw: unknown): { created?: string; versions: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;
  const releases = (meta.releases ?? {}) as Record<string, Array<{ upload_time?: string }>>;
  let created: string | undefined;
  for (const files of Object.values(releases)) {
    for (const f of files ?? []) {
      if (f.upload_time && (!created || f.upload_time < created)) created = f.upload_time;
    }
  }
  return { created, versions: Object.keys(releases).length };
}

function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (now - t) / 86_400_000;
}

// ── the scan ────────────────────────────────────────────────────────────────

export function scanMcpListing(
  listing: McpListing,
  extras: McpScanExtras = {},
  now: number = Date.now(),
): InstallScanResult {
  const out = new Findings();
  const L = "listing";

  // MCP-01 status
  if (listing.status && listing.status !== "active") {
    out.add("MCP-01", L, `The registry marks this listing "${listing.status}".`, listing.status);
  }

  // MCP-02 remotes
  for (const r of listing.remotes ?? []) {
    const u = parseUrl(r.url ?? "");
    if (!u) {
      out.add("MCP-02", L, "The remote URL does not parse.", r.url);
      continue;
    }
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      out.add("MCP-02", L, "The remote endpoint is not https.", r.url);
    } else if (isExfilUrl(r.url) || isSuspiciousSkillInstallUrl(r.url)) {
      out.add("MCP-02", L, "The remote endpoint is on a raw IP, paste or tunnel host.", r.url);
    }
  }

  const owner = ownerOf(listing.name);
  for (const pkg of listing.packages ?? []) {
    const file = `package:${pkg.identifier}`;

    // MCP-03 typosquat
    const known = typosquatOf(pkg.identifier ?? "");
    if (known) {
      out.add("MCP-03", file, `"${pkg.identifier}" is a near-miss of "${known}".`, pkg.identifier);
    }

    // MCP-06 arguments
    for (const a of [...argStrings(pkg.runtimeArguments), ...argStrings(pkg.packageArguments)]) {
      if (DOWNLOAD_RUN.test(a)) {
        out.add("MCP-06", file, "An argument downloads something and runs it.", a);
      } else if (SHELL_META.test(a)) {
        out.add("MCP-06", file, "An argument contains shell metacharacters.", a);
      }
    }

    // MCP-07 broad credentials
    for (const e of pkg.environmentVariables ?? []) {
      if (
        e.name &&
        BROAD_CREDENTIAL_ENV.test(e.name) &&
        !(e.description ?? "").match(/scope|read[- ]?only|permission/i)
      ) {
        out.add("MCP-07", file, `Asks for ${e.name} without saying which scope it needs.`, e.name);
      }
    }

    // MCP-04 / MCP-05 from npm metadata
    if (pkg.registryType === "npm") {
      const npm = readNpmMeta(extras.npmMeta, pkg);
      if (npm) {
        for (const key of ["preinstall", "install", "postinstall"]) {
          const script = npm.scripts[key];
          if (script)
            out.add("MCP-04", file, `Runs a "${key}" script on install.`, `${key}: ${script}`);
        }
        const age = daysSince(npm.created, now);
        if (age !== undefined && age < 7) {
          out.add(
            "MCP-05",
            file,
            `First published ${Math.max(0, Math.floor(age))} day(s) ago.`,
            npm.created,
          );
        } else if (npm.versions <= 1 && npm.maintainers <= 1) {
          out.add("MCP-05", file, "A single version from a single maintainer.");
        }
      }
    }
    if (pkg.registryType === "pypi") {
      const py = readPypiMeta(extras.pypiMeta);
      if (py) {
        const age = daysSince(py.created, now);
        if (age !== undefined && age < 7) {
          out.add(
            "MCP-05",
            file,
            `First published ${Math.max(0, Math.floor(age))} day(s) ago.`,
            py.created,
          );
        } else if (py.versions <= 1) {
          out.add("MCP-05", file, "Only one release so far.");
        }
      }
    }
  }

  // MCP-08 repository
  const repoUrl = listing.repository?.url;
  if (repoUrl) {
    const u = parseUrl(repoUrl);
    if (!u || !REPO_HOSTS.test(u.hostname)) {
      out.add("MCP-08", L, "The repository is not on GitHub, GitLab or Bitbucket.", repoUrl);
    } else if (owner) {
      const repoOwner = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      if (repoOwner && repoOwner !== owner) {
        out.add(
          "MCP-08",
          L,
          `The listing is published as io.github.${owner} but the repository belongs to ${repoOwner}.`,
          repoUrl,
        );
      }
    }
  }

  // MCP-09 / MCP-10 via the skill scanner on the text we have.
  const texts: Array<{ path: string; contents: string }> = [];
  const descr = [listing.title, listing.description].filter(Boolean).join("\n");
  if (descr) texts.push({ path: "description.md", contents: descr });
  if (extras.readme)
    texts.push({ path: "README.md", contents: extras.readme.slice(0, MAX_README_CHARS) });
  if (texts.length) {
    const textScan = scanSkillSnapshotFiles(texts);
    for (const f of textScan.findings) {
      if (/^EXE-0[1-4]$/.test(f.rule)) {
        out.add("MCP-10", f.file, `${f.title}: ${f.reason}`, f.evidence, f.line);
      } else if (/^(INJ|HID)-/.test(f.rule)) {
        out.add("MCP-09", f.file, `${f.title}: ${f.reason}`, f.evidence, f.line);
      }
    }
  }

  // Checks that could not run are notes, never a crash.
  for (const note of extras.unavailable ?? []) {
    out.list.push({
      rule: "MCP-00",
      title: "Check skipped",
      severity: "low",
      file: L,
      line: 0,
      reason: note,
    });
  }

  const rank: Record<InstallScanSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...out.list].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule),
  );
  return {
    verdict: verdictFor(findings),
    findings,
    summary: summarizeFindings(findings),
    rulesRun: RULE_COUNT,
  };
}

// ── best-effort fetch helpers ───────────────────────────────────────────────

async function getWith(fetchFn: typeof fetch, url: string, accept: string): Promise<Response> {
  return fetchFn(url, {
    headers: { "user-agent": USER_AGENT, accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function fetchNpmMeta(
  identifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  // npm accepts scoped names unescaped: /@scope/name
  const res = await getWith(
    fetchFn,
    `https://registry.npmjs.org/${identifier}`,
    "application/json",
  );
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  return res.json();
}

export async function fetchPypiMeta(name: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const res = await getWith(
    fetchFn,
    `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    "application/json",
  );
  if (!res.ok) throw new Error(`PyPI answered ${res.status}`);
  return res.json();
}

/** README.md of a GitHub repo via raw.githubusercontent.com; default branch from the API, falling back to main/master. */
export async function fetchGithubReadme(
  repoUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const u = parseUrl(repoUrl);
  if (!u || !/(^|\.)github\.com$/i.test(u.hostname)) throw new Error("not a GitHub repository");
  const [owner, repoRaw] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) throw new Error("not an owner/repo URL");
  const repo = repoRaw.replace(/\.git$/, "");
  const branches: string[] = [];
  try {
    const api = await getWith(
      fetchFn,
      `https://api.github.com/repos/${owner}/${repo}`,
      "application/vnd.github+json",
    );
    if (api.ok) {
      const data = (await api.json()) as { default_branch?: string };
      if (data.default_branch) branches.push(data.default_branch);
    }
  } catch {
    // anonymous limits; fall through to guesses
  }
  for (const b of ["main", "master"]) if (!branches.includes(b)) branches.push(b);
  for (const branch of branches) {
    const res = await getWith(
      fetchFn,
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`,
      "text/plain",
    );
    if (res.ok) return res.text();
  }
  throw new Error("README.md not found");
}

/**
 * Gather README and package metadata for a listing, best-effort. Every failure
 * becomes an `unavailable` note that the scan reports as a low finding.
 */
export async function collectMcpScanExtras(
  listing: McpListing,
  fetchFn: typeof fetch = fetch,
): Promise<McpScanExtras> {
  const extras: McpScanExtras = { unavailable: [] };
  const note = (what: string, err: unknown): void => {
    extras.unavailable!.push(
      `Could not check ${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  const npm = listing.packages?.find((p) => p.registryType === "npm");
  const pypi = listing.packages?.find((p) => p.registryType === "pypi");
  const tasks: Promise<void>[] = [];
  if (npm) {
    tasks.push(
      fetchNpmMeta(npm.identifier, fetchFn)
        .then((m) => void (extras.npmMeta = m))
        .catch((e) => note(`the npm package ${npm.identifier}`, e)),
    );
  }
  if (pypi) {
    tasks.push(
      fetchPypiMeta(pypi.identifier, fetchFn)
        .then((m) => void (extras.pypiMeta = m))
        .catch((e) => note(`the PyPI package ${pypi.identifier}`, e)),
    );
  }
  if (listing.repository?.url && /github\.com/i.test(listing.repository.url)) {
    tasks.push(
      fetchGithubReadme(listing.repository.url, fetchFn)
        .then((t) => void (extras.readme = t))
        .catch((e) => note("the repository README", e)),
    );
  }
  await Promise.all(tasks);
  return extras;
}
