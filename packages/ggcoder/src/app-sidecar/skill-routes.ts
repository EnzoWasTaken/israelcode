import type http from "node:http";
import { log } from "../core/logger.js";
import {
  fetchSkillAudits,
  fetchSkillDetails,
  listRepoSkills,
  searchSkills,
  summarizeSkill,
  SkillFinderError,
  type RepoSkillCandidate,
  type SkillAuditVerdict,
  type SkillSnapshot,
  type SkillSummary,
} from "../core/skill-finder.js";
import { scanSkillSnapshotFiles, type InstallScanResult } from "../core/skill-install-scan.js";
import {
  installSkillSnapshot,
  listInstalledSkills,
  removeInstalledSkill,
  SkillInstallError,
  type SkillScope,
} from "../core/skill-install.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * Skill finder: search skills.sh/GitHub, inspect a skill (summary + install
 * scan, nothing executed), install it into the global or project skills
 * folder, list and remove installed ones. Mirrors the shapes in
 * `gg-app/src/agent.ts` (SkillInspection, SkillInstallResult…).
 */

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

interface CachedSnapshot {
  snapshot: SkillSnapshot;
  at: number;
}

/** inspect → install reuses the download instead of fetching twice. */
const snapshotCache = new Map<string, CachedSnapshot>();

function cacheKey(source: string, slug: string): string {
  return `${source.trim().toLowerCase()}#${slug.trim()}`;
}

export function clearSkillSnapshotCache(): void {
  snapshotCache.clear();
}

async function snapshotFor(source: string, slug: string, now = Date.now()): Promise<SkillSnapshot> {
  const key = cacheKey(source, slug);
  const hit = snapshotCache.get(key);
  if (hit && now - hit.at < SNAPSHOT_TTL_MS) return hit.snapshot;
  const snapshot = await fetchSkillDetails(source, slug);
  for (const [k, v] of snapshotCache) if (now - v.at >= SNAPSHOT_TTL_MS) snapshotCache.delete(k);
  snapshotCache.set(key, { snapshot, at: now });
  // A GitHub fetch for a whole repo resolves the slug; cache that too.
  if (snapshot.slug !== slug)
    snapshotCache.set(cacheKey(source, snapshot.slug), { snapshot, at: now });
  return snapshot;
}

export interface SkillInspectionPayload {
  source: string;
  slug: string;
  hash: string;
  sha?: string;
  summary: SkillSummary;
  scan: InstallScanResult;
  audits?: SkillAuditVerdict[];
  candidates?: RepoSkillCandidate[];
}

function emptySummary(): SkillSummary {
  return {
    name: "",
    description: "",
    allowedTools: [],
    metadata: {},
    hasFrontmatter: false,
    hasScripts: false,
    hasHooks: false,
    usesShellInjection: false,
    fileCount: 0,
    totalBytes: 0,
    skillMdLines: 0,
    files: [],
  };
}

function errorStatus(err: unknown): number {
  if (err instanceof SkillFinderError) {
    if (err.status === 404) return 404;
    if (err.status === 403 || err.status === 429) return 429;
    return 502;
  }
  if (err instanceof SkillInstallError) {
    if (err.code === "exists") return 409;
    return 400;
  }
  return 500;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseScope(value: unknown): SkillScope {
  return value === "project" ? "project" : "global";
}

async function inspect(source: string, slug: string): Promise<SkillInspectionPayload> {
  if (!slug) {
    const repo = await listRepoSkills(source);
    if (repo.skills.length !== 1) {
      return {
        source,
        slug: "",
        hash: "",
        sha: repo.sha,
        summary: emptySummary(),
        scan: { verdict: "pass", findings: [], summary: "Pick a skill to scan it", rulesRun: 0 },
        candidates: repo.skills,
      };
    }
    slug = repo.skills[0]!.slug;
  }
  const snapshot = await snapshotFor(source, slug);
  const summary = summarizeSkill(snapshot.files);
  const scan = scanSkillSnapshotFiles(snapshot.files);
  const audits = (await fetchSkillAudits(snapshot.source, [snapshot.slug])).get(snapshot.slug);
  return {
    source: snapshot.source,
    slug: snapshot.slug,
    hash: snapshot.hash,
    ...(snapshot.sha ? { sha: snapshot.sha } : {}),
    summary,
    scan,
    ...(audits ? { audits } : {}),
  };
}

export function handleSkillRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url.startsWith("/skills/search")) {
    const q = new URL(url, `http://${ctx.host}`).searchParams.get("q") ?? "";
    void searchSkills(q)
      .then((result) => json(res, 200, result))
      .catch((err) => json(res, errorStatus(err), { error: message(err) }));
    return true;
  }

  if (method === "POST" && url === "/skills/inspect") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let source: string;
      let slug: string;
      try {
        const body = JSON.parse(raw) as { source?: string; slug?: string };
        source = (body.source ?? "").trim();
        slug = (body.slug ?? "").trim();
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!source) {
        json(res, 400, { error: "missing source (owner/repo)" });
        return;
      }
      try {
        json(res, 200, await inspect(source, slug));
      } catch (err) {
        json(res, errorStatus(err), { error: message(err) });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/skills/install") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: {
        source?: string;
        slug?: string;
        scope?: string;
        projectCwd?: string | null;
        override?: boolean;
        replace?: boolean;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const source = (body.source ?? "").trim();
      const slug = (body.slug ?? "").trim();
      const scope = parseScope(body.scope);
      const projectCwd = body.projectCwd || ctx.cwd;
      if (!source) {
        json(res, 400, { installed: false, error: "missing source (owner/repo)" });
        return;
      }
      if (scope === "project" && !projectCwd) {
        json(res, 400, { installed: false, error: "project scope requires a project." });
        return;
      }
      try {
        const snapshot = await snapshotFor(source, slug);
        const scan = scanSkillSnapshotFiles(snapshot.files);
        const override = body.override === true;
        if (scan.verdict === "block" && !override) {
          json(res, 409, { installed: false, scan, error: "Blocked by the security scan" });
          return;
        }
        const overridden = scan.verdict === "block" && override;
        if (overridden) {
          log("WARN", "app-sidecar", "skill installed despite blocking findings", {
            source: snapshot.source,
            slug: snapshot.slug,
            findings: scan.findings.length,
          });
        }
        const entry = await installSkillSnapshot({
          snapshot,
          scope,
          projectCwd: scope === "project" ? projectCwd : undefined,
          scan,
          overridden,
          replace: body.replace === true,
        });
        json(res, 200, { installed: true, entry, scan });
      } catch (err) {
        json(res, errorStatus(err), { installed: false, error: message(err) });
      }
    });
    return true;
  }

  if (method === "GET" && url.startsWith("/skills/installed")) {
    const project = new URL(url, `http://${ctx.host}`).searchParams.get("project") || ctx.cwd;
    void listInstalledSkills(project || undefined)
      .then((skills) => json(res, 200, { skills }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "listInstalledSkills failed", { message: message(err) });
        json(res, 200, { skills: [] });
      });
    return true;
  }

  if (method === "POST" && url === "/skills/remove") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let name: string;
      let scope: SkillScope;
      let projectCwd: string | undefined;
      try {
        const body = JSON.parse(raw) as {
          name?: string;
          scope?: string;
          projectCwd?: string | null;
        };
        name = (body.name ?? "").trim();
        scope = parseScope(body.scope);
        projectCwd = body.projectCwd || ctx.cwd || undefined;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!name) {
        json(res, 400, { error: "missing skill name" });
        return;
      }
      try {
        const removed = await removeInstalledSkill(name, scope, projectCwd);
        json(res, 200, { removed });
      } catch (err) {
        json(res, errorStatus(err), { error: message(err) });
      }
    });
    return true;
  }

  return false;
}
