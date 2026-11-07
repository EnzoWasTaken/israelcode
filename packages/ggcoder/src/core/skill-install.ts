import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_DIR_NAME } from "@kenkaiiii/gg-core";
import { parseFrontmatter } from "./frontmatter.js";
import type { InstallScanResult, InstallScanVerdict } from "./skill-install-scan.js";
import { safeRelativePath, type SkillSnapshot } from "./skill-finder.js";
import { retryWindowsReplace } from "./session-storage.js";

/**
 * Write a fetched skill snapshot into the skills folder the loader already
 * reads (`skills.ts`): `~/.israelcode/skills/<name>/` or `<project>/.gg/skills/<name>/`.
 *
 * Files land in a temp sibling folder first and are renamed into place, so a
 * half-written skill is never visible to the loader. `skills-lock.json` beside
 * the skill folders remembers where each one came from, its content hash and
 * the scan verdict at install time.
 */

export type SkillScope = "global" | "project";

export const SKILLS_LOCK_FILE = "skills-lock.json";

export interface SkillLockEntry {
  source: string;
  slug: string;
  hash: string;
  sha?: string;
  installedAt: string;
  scannedAt: string;
  verdict: InstallScanVerdict;
  /** The user installed it despite blocking findings. */
  overridden: boolean;
}

export interface SkillsLock {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

export interface InstalledSkill {
  name: string;
  scope: SkillScope;
  /** Folder the skill lives in. */
  path: string;
  source?: string;
  slug?: string;
  hash?: string;
  installedAt?: string;
  scannedAt?: string;
  verdict?: InstallScanVerdict;
  overridden?: boolean;
}

export class SkillInstallError extends Error {
  constructor(
    message: string,
    /** "exists": the folder already holds a different version (pass `replace`). */
    readonly code: "invalid-name" | "unsafe-path" | "exists" | "no-project" = "invalid-name",
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}

const NAME_RE = /^[a-z0-9-]{1,64}$/;

/** Folder the skills of a scope live in. `homeDir` only for tests. */
export function skillsRootFor(
  scope: SkillScope,
  projectCwd?: string | null,
  homeDir: string = os.homedir(),
): string {
  if (scope === "project") {
    if (!projectCwd) throw new SkillInstallError("Project scope needs a project.", "no-project");
    return path.join(projectCwd, ".gg", "skills");
  }
  return path.join(homeDir, APP_DIR_NAME, "skills");
}

/** Folder name for a snapshot: frontmatter `name`, else the slug; null when neither is usable. */
export function skillFolderName(snapshot: Pick<SkillSnapshot, "files" | "slug">): string | null {
  const skillMd = snapshot.files.find((f) => f.path === "SKILL.md")?.contents ?? "";
  const candidates = [parseFrontmatter(skillMd).fields.name ?? "", snapshot.slug];
  for (const raw of candidates) {
    const name = raw.trim().toLowerCase();
    if (NAME_RE.test(name)) return name;
  }
  return null;
}

export function validateSkillName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new SkillInstallError(
      `"${name}" is not a usable skill name (lowercase letters, digits and dashes, up to 64).`,
      "invalid-name",
    );
  }
  return name;
}

// ── Lockfile ────────────────────────────────────────────────────────────────

export async function readSkillsLock(root: string): Promise<SkillsLock> {
  try {
    const raw = await fs.readFile(path.join(root, SKILLS_LOCK_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SkillsLock>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.skills &&
      typeof parsed.skills === "object"
    ) {
      return { version: 1, skills: parsed.skills };
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, skills: {} };
}

async function writeSkillsLock(root: string, lock: SkillsLock): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, SKILLS_LOCK_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  try {
    await retryWindowsReplace(() => fs.rename(temp, target));
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function updateSkillsLock(
  root: string,
  mutate: (lock: SkillsLock) => void,
): Promise<SkillsLock> {
  const lock = await readSkillsLock(root);
  mutate(lock);
  await writeSkillsLock(root, lock);
  return lock;
}

// ── Install ─────────────────────────────────────────────────────────────────

export interface InstallSkillOptions {
  snapshot: SkillSnapshot;
  scope: SkillScope;
  projectCwd?: string | null;
  /** Folder name; defaults to the frontmatter name, then the slug. */
  name?: string;
  scan: InstallScanResult;
  overridden?: boolean;
  /** Replace an existing folder with different contents. */
  replace?: boolean;
  /** Tests only. */
  homeDir?: string;
  now?: () => Date;
}

async function removeDir(dir: string): Promise<void> {
  await retryWindowsReplace(() => fs.rm(dir, { recursive: true, force: true }));
}

/** Write the snapshot under `<root>/<name>/` and record it in the lockfile. */
export async function installSkillSnapshot(options: InstallSkillOptions): Promise<InstalledSkill> {
  const { snapshot, scope, scan } = options;
  const root = skillsRootFor(scope, options.projectCwd, options.homeDir);
  const name = validateSkillName(options.name ?? skillFolderName(snapshot) ?? snapshot.slug);
  const target = path.join(root, name);

  // Every path is re-checked here: the snapshot may come from any fetcher.
  for (const file of snapshot.files) {
    const safe = safeRelativePath(file.path);
    if (!safe || safe !== file.path.replace(/\\/g, "/")) {
      throw new SkillInstallError(`Refused file path "${file.path}".`, "unsafe-path");
    }
  }

  const lock = await readSkillsLock(root);
  const existing = await fs.stat(target).catch(() => null);
  if (existing) {
    const sameHash = lock.skills[name]?.hash === snapshot.hash;
    if (!sameHash && !options.replace) {
      throw new SkillInstallError(
        `A skill named "${name}" is already installed with different contents.`,
        "exists",
      );
    }
  }

  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `.${name}.${process.pid}.${Date.now()}.installing`);
  try {
    await fs.mkdir(temp, { recursive: true });
    for (const file of snapshot.files) {
      const dest = path.join(temp, ...file.path.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.contents, "utf-8");
    }
    if (existing) await removeDir(target);
    await retryWindowsReplace(() => fs.rename(temp, target));
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const entry: SkillLockEntry = {
    source: snapshot.source,
    slug: snapshot.slug,
    hash: snapshot.hash,
    ...(snapshot.sha ? { sha: snapshot.sha } : {}),
    installedAt: now,
    scannedAt: now,
    verdict: scan.verdict,
    overridden: options.overridden === true,
  };
  await updateSkillsLock(root, (l) => {
    l.skills[name] = entry;
  });
  return { name, scope, path: target, ...entry };
}

// ── List / remove ───────────────────────────────────────────────────────────

async function listScope(
  scope: SkillScope,
  projectCwd: string | null | undefined,
  homeDir?: string,
): Promise<InstalledSkill[]> {
  let root: string;
  try {
    root = skillsRootFor(scope, projectCwd, homeDir);
  } catch {
    return [];
  }
  const lock = await readSkillsLock(root);
  const rows = new Map<string, InstalledSkill>();
  let dirents: Dirent[] = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // No skills folder yet.
  }
  for (const entry of dirents) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const hasSkillMd = await fs
      .stat(path.join(dir, "SKILL.md"))
      .then((s) => s.isFile())
      .catch(() => false);
    if (!hasSkillMd) continue;
    const locked = lock.skills[entry.name];
    rows.set(entry.name, { name: entry.name, scope, path: dir, ...(locked ?? {}) });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Installed skills of both scopes (project only when `projectCwd` is given). */
export async function listInstalledSkills(
  projectCwd?: string | null,
  homeDir?: string,
): Promise<InstalledSkill[]> {
  const [global, project] = await Promise.all([
    listScope("global", null, homeDir),
    projectCwd ? listScope("project", projectCwd, homeDir) : Promise.resolve([]),
  ]);
  return [...global, ...project];
}

/** Delete `<root>/<name>/` and its lock entry; false when nothing was there. */
export async function removeInstalledSkill(
  name: string,
  scope: SkillScope,
  projectCwd?: string | null,
  homeDir?: string,
): Promise<boolean> {
  validateSkillName(name);
  const root = skillsRootFor(scope, projectCwd, homeDir);
  const target = path.join(root, name);
  const existed = (await fs.stat(target).catch(() => null)) !== null;
  if (existed) await removeDir(target);
  const lock = await readSkillsLock(root);
  const hadLock = name in lock.skills;
  if (hadLock) {
    delete lock.skills[name];
    await writeSkillsLock(root, lock);
  }
  return existed || hadLock;
}
