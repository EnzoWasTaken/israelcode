import crypto from "node:crypto";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * Find skills to install: skills.sh first (its leaderboard API gives id,
 * source repo, slug and install counts), GitHub repository search as the
 * fallback. Fetch a skill's files as an in-memory snapshot — from the
 * skills.sh download endpoint, or by walking the repo tree on GitHub pinned to
 * a commit SHA — and summarise its SKILL.md frontmatter.
 *
 * Pure fetch + parsing. Nothing from a skill is ever executed, required or
 * written to disk here; the install step (skill-install.ts) writes after the
 * install-time scan (skill-install-scan.ts) has run.
 *
 * skills.sh `/api/*` and `/tele/audit` are undocumented internal endpoints of
 * the `skills` CLI (vercel-labs/skills). They can change; the GitHub path is a
 * full fallback, not a nicety.
 */

export const SKILLS_SH_URL = "https://skills.sh";
export const SKILLS_SH_AUDIT_URL = "https://www.skills.sh/tele/audit";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_RAW_URL = "https://raw.githubusercontent.com";

const USER_AGENT = "israel-code-skill-finder";
const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const AUDIT_TIMEOUT_MS = 3_000;
/** Same caps as the `skills` CLI. */
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_FILES = 1000;
/** `SKILL.md` can sit at the repo root or up to this many folders down. */
const SKILL_CONTAINER_DEPTH = 3;

export type SkillOrigin = "skills.sh" | "github";

export interface SkillSearchResult {
  /** `owner/repo/slug` on skills.sh; `owner/repo` for a GitHub repo hit. */
  id: string;
  /** GitHub `owner/repo`. */
  source: string;
  /** Skill folder slug; "" when the hit is a whole repo (GitHub fallback). */
  slug: string;
  name: string;
  installs?: number;
  stars?: number;
  description?: string;
  origin: SkillOrigin;
  /** Third-party audit verdicts from skills.sh, when the lookup succeeded in time. */
  audits?: SkillAuditVerdict[];
}

export interface SkillSearchResponse {
  results: SkillSearchResult[];
  origin: SkillOrigin;
  /** Set when the primary source failed and the fallback was used, or both failed. */
  notice?: string;
}

export interface SkillAuditVerdict {
  /** "Gen Agent Trust Hub", "Socket" or "Snyk". */
  provider: string;
  risk: "safe" | "low" | "medium" | "high" | "critical" | "unknown";
  score?: number;
  alerts?: number;
}

export interface SkillFile {
  /** Forward-slash path relative to the skill folder. */
  path: string;
  contents: string;
}

export interface SkillSnapshot {
  source: string;
  slug: string;
  files: SkillFile[];
  /** Content hash: skills.sh's when it gave one, else sha256 over the files. */
  hash: string;
  origin: SkillOrigin;
  /** Commit SHA the files were pinned to (GitHub path only). */
  sha?: string;
  /** Folder of the skill inside the repo (GitHub path only). */
  repoPath?: string;
}

export interface RepoSkillCandidate {
  slug: string;
  path: string;
}

/** What the user sees before installing: SKILL.md frontmatter plus derived facts. */
export interface SkillSummary {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools: string[];
  metadata: Record<string, string>;
  hasFrontmatter: boolean;
  hasScripts: boolean;
  hasHooks: boolean;
  /** Claude Code `` !`cmd` `` dynamic injection in the SKILL.md body. */
  usesShellInjection: boolean;
  fileCount: number;
  totalBytes: number;
  skillMdLines: number;
  files: string[];
}

export interface FinderDeps {
  fetch?: typeof fetch;
}

export class SkillFinderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SkillFinderError";
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function getJson<T>(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new SkillFinderError(`${hostOf(url)} did not answer in ${timeoutMs / 1000} s.`);
    }
    throw new SkillFinderError(
      `Couldn't reach ${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new SkillFinderError(
        `${hostOf(url)} is rate limiting this machine. Try again in a few minutes.`,
        res.status,
      );
    }
    if (res.status === 404) throw new SkillFinderError(`Not found on ${hostOf(url)}.`, 404);
    throw new SkillFinderError(`${hostOf(url)} answered ${res.status}.`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new SkillFinderError(`${hostOf(url)} sent something that isn't JSON.`);
  }
}

async function getText(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SkillFinderError(
      `Couldn't fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new SkillFinderError(`${hostOf(url)} answered ${res.status} for ${url}.`);
  return res.text();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

const SOURCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `owner/repo`, or throws a plain message. */
export function parseSource(source: string): { owner: string; repo: string } {
  const trimmed = source.trim().replace(/^https?:\/\/github\.com\//i, "");
  if (!SOURCE_RE.test(trimmed) || trimmed.includes("..")) {
    throw new SkillFinderError(`"${source}" is not an owner/repo.`);
  }
  const [owner, repo] = trimmed.split("/") as [string, string];
  return { owner, repo: repo.replace(/\.git$/, "") };
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug !== "." && slug !== "..";
}

/** A relative, forward-slash, in-folder path; null when it tries to escape. */
export function safeRelativePath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/");
  if (p === "" || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return null;
  const parts = p.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

// ── Search ──────────────────────────────────────────────────────────────────

interface SkillsShSearch {
  skills?: Array<{
    id?: string;
    source?: string;
    skillId?: string;
    name?: string;
    installs?: number;
  }>;
}

interface GitHubRepoSearch {
  items?: Array<{
    full_name?: string;
    name?: string;
    description?: string | null;
    stargazers_count?: number;
  }>;
}

/** Search skills.sh; on failure fall back to GitHub repository search. */
export async function searchSkills(
  query: string,
  deps: FinderDeps = {},
): Promise<SkillSearchResponse> {
  const fetchFn = deps.fetch ?? fetch;
  const q = query.trim();
  if (!q) return { results: [], origin: "skills.sh" };
  let primaryError: string | undefined;
  try {
    const data = await getJson<SkillsShSearch>(
      fetchFn,
      `${SKILLS_SH_URL}/api/search?q=${encodeURIComponent(q)}`,
      SEARCH_TIMEOUT_MS,
    );
    const results: SkillSearchResult[] = [];
    for (const row of data.skills ?? []) {
      const source = typeof row.source === "string" ? row.source : "";
      const slug = typeof row.skillId === "string" ? row.skillId : "";
      if (!SOURCE_RE.test(source) || !isValidSlug(slug)) continue;
      results.push({
        id: typeof row.id === "string" ? row.id : `${source}/${slug}`,
        source,
        slug,
        name: typeof row.name === "string" && row.name ? row.name : slug,
        installs: typeof row.installs === "number" ? row.installs : undefined,
        origin: "skills.sh",
      });
    }
    return { results, origin: "skills.sh" };
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
  }
  try {
    const url =
      `${GITHUB_API_URL}/search/repositories?q=` +
      encodeURIComponent(`${q} SKILL.md in:readme,name,description`) +
      "&sort=stars&per_page=30";
    const data = await getJson<GitHubRepoSearch>(fetchFn, url, SEARCH_TIMEOUT_MS, {
      accept: "application/vnd.github+json",
    });
    const results: SkillSearchResult[] = [];
    for (const item of data.items ?? []) {
      const source = typeof item.full_name === "string" ? item.full_name : "";
      if (!SOURCE_RE.test(source)) continue;
      results.push({
        id: source,
        source,
        slug: "",
        name: typeof item.name === "string" ? item.name : source,
        stars: typeof item.stargazers_count === "number" ? item.stargazers_count : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
        origin: "github",
      });
    }
    return {
      results,
      origin: "github",
      notice: `skills.sh was unavailable (${primaryError}); showing GitHub repositories instead.`,
    };
  } catch (err) {
    const fallbackError = err instanceof Error ? err.message : String(err);
    throw new SkillFinderError(
      `Couldn't search skills. skills.sh: ${primaryError} GitHub: ${fallbackError}`,
    );
  }
}

// ── Audit enrichment ────────────────────────────────────────────────────────

type AuditPayload = Record<
  string,
  Record<string, { risk?: string; score?: number; alerts?: number } | undefined> | undefined
>;

const AUDIT_PROVIDERS: Record<string, string> = {
  ath: "Gen Agent Trust Hub",
  socket: "Socket",
  snyk: "Snyk",
};
const RISKS = new Set(["safe", "low", "medium", "high", "critical", "unknown"]);

/**
 * skills.sh's third-party audit verdicts for skills of one repo. Short timeout,
 * never throws: an empty map means "no verdicts", not "unsafe".
 */
export async function fetchSkillAudits(
  source: string,
  slugs: readonly string[],
  deps: FinderDeps = {},
): Promise<Map<string, SkillAuditVerdict[]>> {
  const out = new Map<string, SkillAuditVerdict[]>();
  if (slugs.length === 0) return out;
  const fetchFn = deps.fetch ?? fetch;
  try {
    const url =
      `${SKILLS_SH_AUDIT_URL}?source=${encodeURIComponent(source)}` +
      `&skills=${encodeURIComponent(slugs.join(","))}`;
    const data = await getJson<AuditPayload>(fetchFn, url, AUDIT_TIMEOUT_MS);
    for (const [slug, providers] of Object.entries(data ?? {})) {
      if (!providers || typeof providers !== "object") continue;
      const verdicts: SkillAuditVerdict[] = [];
      for (const [key, value] of Object.entries(providers)) {
        if (!value || typeof value !== "object") continue;
        const risk = typeof value.risk === "string" ? value.risk.toLowerCase() : "unknown";
        verdicts.push({
          provider: AUDIT_PROVIDERS[key] ?? key,
          risk: (RISKS.has(risk) ? risk : "unknown") as SkillAuditVerdict["risk"],
          score: typeof value.score === "number" ? value.score : undefined,
          alerts: typeof value.alerts === "number" ? value.alerts : undefined,
        });
      }
      if (verdicts.length) out.set(slug, verdicts);
    }
  } catch {
    // Enrichment only.
  }
  return out;
}

// ── Download ────────────────────────────────────────────────────────────────

interface SkillsShDownload {
  files?: Array<{ path?: string; contents?: string }>;
  hash?: string;
}

interface GitHubRepo {
  default_branch?: string;
  private?: boolean;
  stargazers_count?: number;
}

interface GitHubRef {
  object?: { sha?: string };
}

interface GitHubTree {
  sha?: string;
  truncated?: boolean;
  tree?: Array<{ path?: string; type?: string; mode?: string; size?: number }>;
}

/** sha256 over sorted path + contents, so two identical snapshots hash alike. */
export function hashSkillFiles(files: readonly SkillFile[]): string {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update("\0").update(f.contents).update("\0");
  }
  return h.digest("hex");
}

function acceptFiles(raw: Array<{ path?: string; contents?: string }>): SkillFile[] {
  const files: SkillFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const f of raw) {
    if (typeof f.path !== "string" || typeof f.contents !== "string") continue;
    const safe = safeRelativePath(f.path);
    if (!safe) throw new SkillFinderError(`Refused file path "${f.path}" (escapes the skill).`);
    if (seen.has(safe)) continue;
    seen.add(safe);
    bytes += Buffer.byteLength(f.contents, "utf8");
    if (bytes > MAX_SKILL_BYTES) throw new SkillFinderError("Skill is larger than 10 MiB.");
    files.push({ path: safe, contents: f.contents });
    if (files.length > MAX_SKILL_FILES) throw new SkillFinderError("Skill has over 1000 files.");
  }
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new SkillFinderError("No SKILL.md at the top of the skill folder.");
  }
  return files;
}

/** The skills.sh snapshot, then the GitHub tree when skills.sh fails. */
export async function fetchSkillDetails(
  source: string,
  slug: string,
  deps: FinderDeps = {},
): Promise<SkillSnapshot> {
  const { owner, repo } = parseSource(source);
  const fetchFn = deps.fetch ?? fetch;
  if (slug && isValidSlug(slug)) {
    try {
      const data = await getJson<SkillsShDownload>(
        fetchFn,
        `${SKILLS_SH_URL}/api/download/${owner}/${repo}/${encodeURIComponent(slug)}`,
        DOWNLOAD_TIMEOUT_MS,
      );
      if (Array.isArray(data.files) && data.files.length > 0) {
        const files = acceptFiles(data.files);
        return {
          source: `${owner}/${repo}`,
          slug,
          files,
          hash: typeof data.hash === "string" && data.hash ? data.hash : hashSkillFiles(files),
          origin: "skills.sh",
        };
      }
    } catch (err) {
      if (err instanceof SkillFinderError && err.message.startsWith("Refused")) throw err;
      // Fall through to GitHub.
    }
  } else if (slug) {
    throw new SkillFinderError(`"${slug}" is not a valid skill name.`);
  }
  return fetchSkillFromGitHub(`${owner}/${repo}`, slug, deps);
}

/** Depth-limited `SKILL.md` discovery: root, `skills/<x>/`, `.claude/skills/<x>/`… */
export function findSkillCandidates(paths: readonly string[], repo: string): RepoSkillCandidate[] {
  const out: RepoSkillCandidate[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    if (parts[parts.length - 1] !== "SKILL.md") continue;
    const dirs = parts.slice(0, -1);
    if (dirs.length > SKILL_CONTAINER_DEPTH) continue;
    if (dirs.some((d) => d === "node_modules" || d === "test" || d === "tests")) continue;
    const slug = dirs.length === 0 ? repo : dirs[dirs.length - 1]!;
    if (!isValidSlug(slug)) continue;
    out.push({ slug, path: dirs.join("/") });
  }
  // Prefer the shallowest folder for a duplicated slug.
  out.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.slug) ? false : (seen.add(c.slug), true)));
}

async function githubTree(
  source: string,
  deps: FinderDeps,
): Promise<{ sha: string; tree: NonNullable<GitHubTree["tree"]>; stars?: number }> {
  const fetchFn = deps.fetch ?? fetch;
  const headers = { accept: "application/vnd.github+json" };
  const meta = await getJson<GitHubRepo>(
    fetchFn,
    `${GITHUB_API_URL}/repos/${source}`,
    DOWNLOAD_TIMEOUT_MS,
    headers,
  );
  const branch = typeof meta.default_branch === "string" ? meta.default_branch : "main";
  const ref = await getJson<GitHubRef>(
    fetchFn,
    `${GITHUB_API_URL}/repos/${source}/git/ref/heads/${encodeURIComponent(branch)}`,
    DOWNLOAD_TIMEOUT_MS,
    headers,
  );
  const sha = ref.object?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new SkillFinderError(`GitHub gave no commit for ${source}@${branch}.`);
  }
  const treeRes = await getJson<GitHubTree>(
    fetchFn,
    `${GITHUB_API_URL}/repos/${source}/git/trees/${sha}?recursive=1`,
    DOWNLOAD_TIMEOUT_MS,
    headers,
  );
  return {
    sha,
    tree: treeRes.tree ?? [],
    stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : undefined,
  };
}

/** Which skills a GitHub repo holds (for repo hits from the search fallback). */
export async function listRepoSkills(
  source: string,
  deps: FinderDeps = {},
): Promise<{ sha: string; stars?: number; skills: RepoSkillCandidate[] }> {
  const { owner, repo } = parseSource(source);
  const { sha, tree, stars } = await githubTree(`${owner}/${repo}`, deps);
  const paths = tree
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string);
  return { sha, stars, skills: findSkillCandidates(paths, repo) };
}

async function fetchSkillFromGitHub(
  source: string,
  slug: string,
  deps: FinderDeps,
): Promise<SkillSnapshot> {
  const fetchFn = deps.fetch ?? fetch;
  const { sha, tree } = await githubTree(source, deps);
  const repo = source.split("/")[1]!;
  const blobPaths = tree
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string);
  const candidates = findSkillCandidates(blobPaths, repo);
  let folder: RepoSkillCandidate | undefined;
  if (slug) {
    folder = candidates.find((c) => c.slug === slug);
    if (!folder) {
      throw new SkillFinderError(`No skill "${slug}" found in ${source} (looked for SKILL.md).`);
    }
  } else if (candidates.length === 1) {
    folder = candidates[0];
  } else if (candidates.length === 0) {
    throw new SkillFinderError(`No SKILL.md found in ${source}.`);
  } else {
    throw new SkillFinderError(
      `${source} holds ${candidates.length} skills: ${candidates
        .map((c) => c.slug)
        .slice(0, 12)
        .join(", ")}. Pick one.`,
    );
  }
  const prefix = folder.path ? `${folder.path}/` : "";
  const entries = tree.filter(
    (e) => typeof e.path === "string" && (prefix === "" || e.path.startsWith(prefix)),
  );
  // Only regular files travel; a symlink entry (mode 120000) is a finding at
  // scan time and never written, so it is dropped here with a marker file.
  const picked: Array<{ path: string; size: number; symlink: boolean }> = [];
  let bytes = 0;
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const rel = (e.path as string).slice(prefix.length);
    if (!safeRelativePath(rel)) throw new SkillFinderError(`Refused file path "${e.path}".`);
    const symlink = e.mode === "120000";
    const size = typeof e.size === "number" ? e.size : 0;
    bytes += size;
    if (bytes > MAX_SKILL_BYTES) throw new SkillFinderError("Skill is larger than 10 MiB.");
    picked.push({ path: rel, size, symlink });
    if (picked.length > MAX_SKILL_FILES) throw new SkillFinderError("Skill has over 1000 files.");
  }
  if (picked.some((p) => p.symlink)) {
    const links = picked.filter((p) => p.symlink).map((p) => p.path);
    throw new SkillFinderError(`Refused: the skill contains symlinks (${links.join(", ")}).`);
  }
  const files: SkillFile[] = [];
  const queue = [...picked];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const url = `${GITHUB_RAW_URL}/${source}/${sha}/${prefix}${next.path}`;
      files.push({ path: next.path, contents: await getText(fetchFn, url, DOWNLOAD_TIMEOUT_MS) });
    }
  });
  await Promise.all(workers);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const accepted = acceptFiles(files);
  return {
    source,
    slug: folder.slug,
    files: accepted,
    hash: hashSkillFiles(accepted),
    origin: "github",
    sha,
    repoPath: folder.path,
  };
}

// ── Summary ─────────────────────────────────────────────────────────────────

const SHELL_INJECTION = /!`[^`\n]+`/;

/** Facts about a skill from its files alone: frontmatter and layout. */
export function summarizeSkill(files: readonly SkillFile[]): SkillSummary {
  const skillMd = files.find((f) => f.path === "SKILL.md")?.contents ?? "";
  const fm = parseFrontmatter(skillMd);
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fm.fields)) {
    if (key.startsWith("metadata.")) metadata[key.slice("metadata.".length)] = value;
  }
  // `metadata:` nested map: the flat parser folds its lines into one value, so
  // read the indented `key: value` lines under it from the raw block instead.
  const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*$/m.exec(skillMd)?.[1] ?? "";
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((l) => /^metadata\s*:\s*$/i.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (!/^\s/.test(line)) break;
      const m = /^\s+([\w.-]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (m) metadata[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  const allowedTools = (fm.fields["allowed-tools"] ?? fm.fields.allowed_tools ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const paths = files.map((f) => f.path);
  return {
    name: fm.fields.name ?? "",
    description: fm.fields.description ?? "",
    license: fm.fields.license || undefined,
    compatibility: fm.fields.compatibility || undefined,
    allowedTools,
    metadata,
    hasFrontmatter: fm.hasFrontmatter,
    hasScripts: paths.some(
      (p) => p.startsWith("scripts/") || /\.(sh|ps1|py|js|mjs|cjs|ts|rb|pl|bat|cmd)$/i.test(p),
    ),
    hasHooks: Boolean(fm.fields.hooks) || paths.some((p) => /(^|\/)hooks(\/|\.json$)/.test(p)),
    usesShellInjection: SHELL_INJECTION.test(fm.body),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + Buffer.byteLength(f.contents, "utf8"), 0),
    skillMdLines: skillMd ? skillMd.split(/\r?\n/).length : 0,
    files: paths,
  };
}
