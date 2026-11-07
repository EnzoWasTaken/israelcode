import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { copyLocalFiles, worktreePathFor } from "../app-sidecar/git-branches.js";
import {
  listWorktrees,
  parseWorktreePorcelain,
  resolveSetupCommand,
} from "../app-sidecar/worktrees.js";
import {
  BackgroundGitError,
  getGitDirtyFileCount,
  realpathNative,
  runBackgroundGit,
} from "../utils/git.js";
import { log } from "./logger.js";

/**
 * Worktree-isolated workers: each child agent that edits files gets its own
 * git worktree on its own `gg/worker/<slug>-<nonce>` branch under the managed
 * worktrees folder (`~/.israelcode/worktrees`), so parallel workers never
 * trample each other. When a worker is done, the orchestrator (and the user)
 * reviews its diff against the base branch, previews conflicts, runs the
 * project's checks inside the worktree, then merges it (squash by default)
 * into the base branch in the main folder, or discards it. Worktrees with no
 * changes are pruned automatically.
 *
 * Every git call goes through `runBackgroundGit` (hooks and repo-config
 * execution sinks disabled): these are Israel Code's own operations.
 */

const READ_TIMEOUT_MS = 10_000;
/** `git worktree add` / `git merge` check out files: give a big tree time. */
const WRITE_TIMEOUT_MS = 120_000;
/** Chars of unified diff handed to the app and the orchestrator. */
export const DIFF_PATCH_LIMIT = 200_000;
export const WORKER_BRANCH_PREFIX = "gg/worker/";

export interface WorkerWorktree {
  /** Real path of the worktree folder. */
  path: string;
  /** The worker's branch (`gg/worker/<slug>-<nonce>`). */
  branch: string;
  /** The branch it was cut from and merges back into. */
  base: string;
}

export interface WorktreeStatus {
  /** Uncommitted changes in the worktree. */
  dirty: number;
  /** Commits on the worker's branch the base doesn't have. */
  ahead: number;
  /** Files that differ from the base (committed or not). */
  changedFiles: number;
}

export interface WorktreeDiffFile {
  path: string;
  /** git's one-letter status: A, M, D, R, … */
  status: string;
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  files: WorktreeDiffFile[];
  /** Unified diff, cut at `DIFF_PATCH_LIMIT` chars. */
  patch: string;
  truncated: boolean;
}

/** A merge-review operation refused; `message` is safe to show. */
export class WorktreeWorkerError extends Error {
  override name = "WorktreeWorkerError";
  constructor(
    message: string,
    /** Files involved (uncommitted in the main folder, or conflicting). */
    readonly files: readonly string[] = [],
  ) {
    super(message);
  }
}

function gitDetail(error: unknown): string {
  const raw =
    error instanceof BackgroundGitError
      ? error.stderr || error.stdout || error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.trim().split("\n").slice(-4).join("\n") || "git failed";
}

async function git(
  args: readonly string[],
  cwd: string,
  timeoutMs = READ_TIMEOUT_MS,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await runBackgroundGit(args, {
    cwd,
    timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout;
}

// `native`: on Windows it expands 8.3 short names (RUNNER~1), so a path from
// git and one from Node compare equal (see worktrees.ts).
const realOr = (p: string): Promise<string> => realpathNative(p).catch(() => path.resolve(p));

/** The repository's main folder (toplevel of `dir`), as a real path. */
async function repoTop(dir: string): Promise<string> {
  return realOr((await git(["rev-parse", "--show-toplevel"], dir)).trim());
}

/** The checked-out branch, or null when detached. */
async function currentBranch(dir: string): Promise<string | null> {
  try {
    return (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir)).trim() || null;
  } catch {
    return null;
  }
}

/** Author/committer for Israel Code's own WIP commits when the repo has no identity. */
async function identityEnv(cwd: string): Promise<Record<string, string> | undefined> {
  const has = await git(["config", "--get", "user.email"], cwd)
    .then((s) => s.trim().length > 0)
    .catch(() => false);
  if (has) return undefined;
  return {
    GIT_AUTHOR_NAME: "Israel Code",
    GIT_AUTHOR_EMAIL: "worker@israelcode.local",
    GIT_COMMITTER_NAME: "Israel Code",
    GIT_COMMITTER_EMAIL: "worker@israelcode.local",
  };
}

/** `gg/worker/<slug>-<nonce>`: the slug is the agent and task names, lower-case, dashed. */
export function workerBranchName(
  agentName: string | undefined,
  taskName: string,
  nonce: string,
): string {
  const slug = [agentName ?? "", taskName]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const clean = nonce.replace(/[^a-z0-9]/gi, "").toLowerCase() || randomBytes(3).toString("hex");
  return `${WORKER_BRANCH_PREFIX}${slug || "task"}-${clean}`;
}

/** Start the worktree's setup command (install) without waiting for it. */
function startSetup(worktreePath: string, command: string): void {
  try {
    const child = spawn(command, {
      cwd: worktreePath,
      shell: true,
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.on("error", (error) => {
      log("WARN", "worktree-workers", "worktree setup failed to start", {
        command,
        error: error.message,
      });
    });
    child.unref();
  } catch (error) {
    log("WARN", "worktree-workers", "worktree setup failed to start", {
      command,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface CreateWorkerWorktreeOptions {
  /** Any folder of the repository (the parent's cwd). */
  repoRoot: string;
  /** Branch to cut from; default: the main folder's current branch (or HEAD when detached). */
  base?: string;
  /** The worker's task name (goes into the branch slug). */
  name: string;
  /** The agent's name (goes into the branch slug). */
  agentName?: string;
  /** Where managed worktrees live (`~/.israelcode/worktrees`). */
  managedRoot: string;
  /** Run the worktree's setup command in the background (default true). */
  setup?: boolean;
}

/**
 * Make a worker's worktree: `git worktree add -b <branch> <path> <base>` under
 * the managed folder, copy the ignored local files the checkout lacks, and
 * kick off its setup command (`.gg/worktree.json` or the lockfile install)
 * without waiting for it.
 */
export async function createWorkerWorktree(
  options: CreateWorkerWorktreeOptions,
): Promise<WorkerWorktree> {
  const root = await repoTop(options.repoRoot).catch((error: unknown) => {
    throw new WorktreeWorkerError(`Not a git repository: ${gitDetail(error)}`);
  });
  const base =
    options.base?.trim() ||
    (await currentBranch(root)) ||
    (await git(["rev-parse", "HEAD"], root)).trim();
  const branch = workerBranchName(options.agentName, options.name, randomBytes(3).toString("hex"));
  const target = await worktreePathFor(options.managedRoot, root, branch);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await git(["worktree", "add", "-b", branch, target, base], root, WRITE_TIMEOUT_MS);
  } catch (error) {
    throw new WorktreeWorkerError(`Couldn't create the worker's worktree: ${gitDetail(error)}`);
  }
  const real = await realOr(target);
  await copyLocalFiles(root, real).catch(() => []);
  if (options.setup !== false) {
    const setup = await resolveSetupCommand(real).catch(() => null);
    if (setup) startSetup(real, setup.command);
  }
  log("INFO", "worktree-workers", "worker worktree created", { branch, path: real, base });
  return { path: real, branch, base };
}

/** The merge base of `base` and the worktree's HEAD, or null when unrelated. */
async function mergeBase(cwd: string, base: string, head = "HEAD"): Promise<string | null> {
  try {
    return (await git(["merge-base", base, head], cwd)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The worktree's state against its base: uncommitted changes, commits ahead,
 * and the number of files that differ (committed or not). `base` defaults to
 * the main folder's current branch.
 */
export async function worktreeStatus(worktreePath: string, base?: string): Promise<WorktreeStatus> {
  const real = await realOr(worktreePath);
  if (!existsSync(real)) return { dirty: 0, ahead: 0, changedFiles: 0 };
  const resolvedBase = base?.trim() || (await mainBranchOf(real)) || "HEAD";
  const dirty = await getGitDirtyFileCount(real, { timeoutMs: READ_TIMEOUT_MS }).catch(() => 0);
  const fork = await mergeBase(real, resolvedBase);
  let ahead = 0;
  const changed = new Set<string>();
  if (fork) {
    const count = await git(["rev-list", "--count", `${fork}..HEAD`], real).catch(() => "0");
    ahead = Number.parseInt(count.trim(), 10) || 0;
    // Committed and uncommitted changes relative to the fork point, in one list.
    const names = await git(["diff", "--name-only", "-z", fork], real).catch(() => "");
    for (const name of names.split("\0")) if (name) changed.add(name);
  }
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], real).catch(
    () => "",
  );
  for (const name of untracked.split("\0")) if (name) changed.add(name);
  return { dirty, ahead, changedFiles: changed.size };
}

/** The main folder's current branch for any checkout of the repository. */
async function mainBranchOf(dir: string): Promise<string | null> {
  try {
    const listed = parseWorktreePorcelain(await git(["worktree", "list", "--porcelain"], dir));
    return listed[0]?.branch ?? null;
  } catch {
    return null;
  }
}

/** The worktree that has `branch` checked out, as a real path, or null. */
export async function worktreeForBranch(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const listed = parseWorktreePorcelain(await git(["worktree", "list", "--porcelain"], repoRoot));
    const row = listed.find((entry) => entry.branch === branch);
    return row ? await realOr(row.path) : null;
  } catch {
    return null;
  }
}

/**
 * Commit whatever is uncommitted in the worktree as `WIP: worker <name>` so the
 * diff, the preview and the merge all see the same tree. Returns true when a
 * commit was made.
 */
export async function commitWorkInProgress(worktreePath: string, name: string): Promise<boolean> {
  const dirty = await getGitDirtyFileCount(worktreePath, { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => 0,
  );
  if (dirty === 0) return false;
  const env = await identityEnv(worktreePath);
  try {
    await git(["add", "-A"], worktreePath, WRITE_TIMEOUT_MS);
    await git(
      ["commit", "--quiet", "--no-verify", "-m", `WIP: worker ${name}`],
      worktreePath,
      WRITE_TIMEOUT_MS,
      env,
    );
    return true;
  } catch (error) {
    throw new WorktreeWorkerError(`Couldn't commit the worker's changes: ${gitDetail(error)}`);
  }
}

/** The worker's display name from its branch (`gg/worker/<slug>-<nonce>` → `<slug>`). */
export function workerNameFromBranch(branch: string): string {
  const tail = branch.startsWith(WORKER_BRANCH_PREFIX)
    ? branch.slice(WORKER_BRANCH_PREFIX.length)
    : branch;
  return tail.replace(/-[a-z0-9]{6}$/, "") || tail;
}

/**
 * The worker's changes against the merge-base with its base branch, after
 * committing anything uncommitted in the worktree (so nothing is left behind
 * by a later merge). `files` carries per-file status and line counts; `patch`
 * is the unified diff, cut at `DIFF_PATCH_LIMIT` chars.
 */
export async function worktreeDiff(
  repoRoot: string,
  worktree: WorkerWorktree,
): Promise<WorktreeDiff> {
  const root = await repoTop(repoRoot);
  if (existsSync(worktree.path)) {
    await commitWorkInProgress(worktree.path, workerNameFromBranch(worktree.branch));
  }
  const range = `${worktree.base}...${worktree.branch}`;
  let numstat: string;
  let names: string;
  let patch: string;
  try {
    [numstat, names, patch] = await Promise.all([
      git(["diff", "--numstat", "-z", range], root),
      git(["diff", "--name-status", "-z", range], root),
      git(["diff", "--no-color", range], root),
    ]);
  } catch (error) {
    throw new WorktreeWorkerError(`Couldn't diff the worker's branch: ${gitDetail(error)}`);
  }
  const statusByPath = new Map<string, string>();
  // name-status -z: "<status>\0<path>\0" and for renames "R<n>\0<old>\0<new>\0".
  const parts = names.split("\0");
  for (let i = 0; i < parts.length;) {
    const status = parts[i] ?? "";
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const to = parts[i + 2] ?? "";
      if (to) statusByPath.set(to, status[0] ?? "R");
      i += 3;
    } else {
      const file = parts[i + 1] ?? "";
      if (file) statusByPath.set(file, status[0] ?? "M");
      i += 2;
    }
  }
  const files: WorktreeDiffFile[] = [];
  // numstat -z: "<add>\t<del>\t<path>\0", renames "<add>\t<del>\t\0<old>\0<new>\0".
  const stats = numstat.split("\0");
  for (let i = 0; i < stats.length;) {
    const line = stats[i] ?? "";
    if (!line) break;
    const [add = "0", del = "0", inline = ""] = line.split("\t");
    let file = inline;
    if (!file) {
      file = stats[i + 2] ?? "";
      i += 3;
    } else {
      i += 1;
    }
    if (!file) continue;
    files.push({
      path: file,
      status: statusByPath.get(file) ?? "M",
      additions: add === "-" ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === "-" ? 0 : Number.parseInt(del, 10) || 0,
    });
  }
  const truncated = patch.length > DIFF_PATCH_LIMIT;
  return {
    files,
    patch: truncated
      ? `${patch.slice(0, DIFF_PATCH_LIMIT)}\n[diff truncated at ${DIFF_PATCH_LIMIT} chars]`
      : patch,
    truncated,
  };
}

/** Parse `git merge-tree --write-tree --name-only -z`: the conflicted paths. */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const [, ...rest] = stdout.split("\0");
  const conflicts: string[] = [];
  for (const entry of rest) {
    if (entry === "") break;
    conflicts.push(entry);
  }
  return [...new Set(conflicts)];
}

/**
 * Would merging `branch` into the main folder's HEAD conflict? Uses
 * `git merge-tree --write-tree` (git ≥ 2.38, touches no files); older gits
 * fall back to a trial `git merge --no-commit --no-ff` in a throwaway detached
 * worktree.
 */
export async function previewMerge(
  repoRoot: string,
  branch: string,
): Promise<{ conflicts: string[] }> {
  const root = await repoTop(repoRoot);
  const workPath = await worktreeForBranch(root, branch);
  if (workPath) await commitWorkInProgress(workPath, workerNameFromBranch(branch));
  try {
    const stdout = await git(
      ["merge-tree", "--write-tree", "--name-only", "-z", "HEAD", branch],
      root,
      WRITE_TIMEOUT_MS,
    );
    return { conflicts: parseMergeTreeConflicts(stdout) };
  } catch (error) {
    if (error instanceof BackgroundGitError && error.code === 1) {
      return { conflicts: parseMergeTreeConflicts(error.stdout) };
    }
    const detail = gitDetail(error);
    // 129 = usage error: an old git without --write-tree.
    if (!(error instanceof BackgroundGitError && error.code === 129)) {
      throw new WorktreeWorkerError(`Couldn't preview the merge: ${detail}`);
    }
  }
  return { conflicts: await previewMergeInTempWorktree(root, branch) };
}

async function previewMergeInTempWorktree(root: string, branch: string): Promise<string[]> {
  const temp = path.join(path.dirname(root), `.gg-merge-preview-${randomBytes(4).toString("hex")}`);
  try {
    await git(["worktree", "add", "--detach", temp, "HEAD"], root, WRITE_TIMEOUT_MS);
    try {
      await git(["merge", "--no-commit", "--no-ff", branch], temp, WRITE_TIMEOUT_MS);
      return [];
    } catch {
      const out = await git(["diff", "--name-only", "--diff-filter=U", "-z"], temp).catch(() => "");
      return out.split("\0").filter(Boolean);
    }
  } finally {
    await git(["worktree", "remove", "--force", temp], root, WRITE_TIMEOUT_MS).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface MergeWorkerOptions {
  repoRoot: string;
  branch: string;
  /** `squash`: one commit on the base; `merge`: a merge commit (`--no-ff`). */
  mode: "squash" | "merge";
  message?: string;
}

/**
 * Merge the worker's branch into the main folder's checked-out branch. Refused
 * when the main folder has uncommitted changes to files the worker also
 * changed (they'd be clobbered or block the merge); those files are reported.
 * A conflicting merge is rolled back and reported.
 */
export async function mergeWorker(
  options: MergeWorkerOptions,
): Promise<{ merged: true; commit: string }> {
  const root = await repoTop(options.repoRoot);
  const branch = options.branch;
  const workPath = await worktreeForBranch(root, branch);
  if (workPath) await commitWorkInProgress(workPath, workerNameFromBranch(branch));
  let changed: string[];
  try {
    changed = (await git(["diff", "--name-only", "-z", `HEAD...${branch}`], root))
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    throw new WorktreeWorkerError(`Couldn't read the worker's branch: ${gitDetail(error)}`);
  }
  if (changed.length === 0) {
    throw new WorktreeWorkerError("This worker's branch has no changes to merge.");
  }
  const dirtyMain = (
    await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root).catch(() => "")
  )
    .split("\0")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const blocked = changed.filter((file) => dirtyMain.includes(file));
  if (blocked.length > 0) {
    throw new WorktreeWorkerError(
      `The project folder has uncommitted changes to ${blocked.length} ${
        blocked.length === 1 ? "file" : "files"
      } this worker also changed. Commit or stash them first.`,
      blocked,
    );
  }
  const message =
    options.message?.trim() || `Merge worker ${workerNameFromBranch(branch)} (${branch})`;
  const env = await identityEnv(root);
  try {
    if (options.mode === "squash") {
      // Even a squash merge needs an identity (git builds the merge message).
      await git(["merge", "--squash", branch], root, WRITE_TIMEOUT_MS, env);
      await git(["commit", "--quiet", "--no-verify", "-m", message], root, WRITE_TIMEOUT_MS, env);
    } else {
      await git(
        ["merge", "--no-ff", "--no-verify", "-m", message, branch],
        root,
        WRITE_TIMEOUT_MS,
        env,
      );
    }
  } catch (error) {
    const conflicts = (
      await git(["diff", "--name-only", "--diff-filter=U", "-z"], root).catch(() => "")
    )
      .split("\0")
      .filter(Boolean);
    // Roll back whatever the failed merge staged; the main folder was clean on these files.
    await git(["merge", "--abort"], root, WRITE_TIMEOUT_MS).catch(() => {});
    await git(["reset", "--merge"], root, WRITE_TIMEOUT_MS).catch(() => {});
    throw new WorktreeWorkerError(
      conflicts.length > 0
        ? `Merging conflicts in ${conflicts.length} ${conflicts.length === 1 ? "file" : "files"}; resolve them in the worker's worktree first.`
        : `Merge failed: ${gitDetail(error)}`,
      conflicts,
    );
  }
  const commit = (await git(["rev-parse", "HEAD"], root)).trim();
  log("INFO", "worktree-workers", "worker merged", { branch, mode: options.mode, commit });
  return { merged: true, commit };
}

/** Remove the worker's worktree folder and delete its branch (commits and all). */
export async function discardWorker(options: {
  repoRoot: string;
  path?: string;
  branch: string;
}): Promise<void> {
  const root = await repoTop(options.repoRoot);
  const target = options.path ?? (await worktreeForBranch(root, options.branch));
  if (target) {
    const real = await realOr(target);
    await git(["worktree", "remove", "--force", real], root, WRITE_TIMEOUT_MS).catch(
      async (error: unknown) => {
        log("WARN", "worktree-workers", "worktree remove failed; pruning", {
          path: real,
          error: gitDetail(error),
        });
        await fs.rm(real, { recursive: true, force: true }).catch(() => {});
        await git(["worktree", "prune"], root, WRITE_TIMEOUT_MS).catch(() => {});
      },
    );
    // `<repo>-<hash>/` holds only this project's worktrees; drop it once empty.
    await fs.rmdir(path.dirname(real)).catch(() => {});
  }
  await git(["branch", "-D", options.branch], root, WRITE_TIMEOUT_MS).catch(() => {});
  log("INFO", "worktree-workers", "worker discarded", { branch: options.branch });
}

/**
 * Remove every managed `gg/worker/*` worktree that has neither uncommitted
 * changes nor commits of its own, with its branch. Returns the branches dropped.
 */
export async function pruneEmptyWorktrees(
  repoRoot: string,
  managedRoot: string,
): Promise<string[]> {
  const list = await listWorktrees(repoRoot, managedRoot);
  if (!list) return [];
  const dropped: string[] = [];
  for (const row of list.worktrees) {
    if (!row.managed || !row.branch?.startsWith(WORKER_BRANCH_PREFIX)) continue;
    if (!row.missing && (row.dirty > 0 || row.ahead > 0)) continue;
    await discardWorker({ repoRoot: list.mainPath, path: row.path, branch: row.branch });
    dropped.push(row.branch);
  }
  return dropped;
}
