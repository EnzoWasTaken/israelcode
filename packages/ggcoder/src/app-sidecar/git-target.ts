import type { GoalRecord } from "../core/goals-store.js";
import {
  getGitBranch,
  getGitDirtyFileCount,
  isGitRepo,
  type GitReadOptions,
} from "../utils/git.js";
import { getGitHubRepoSlug } from "../utils/github.js";

/**
 * The folder whose git state a window's titlebar shows (branch, uncommitted
 * files, GitHub, CI, Project Health). Normally the window's cwd. A Goal
 * window's cwd is the goal's own folder under `~/.israelcode/goals`, which is not a
 * repo, so it uses the first attached folder that is inside a git work tree:
 * the project the goal is actually changing.
 *
 * `settled` is false when a folder's check failed or timed out before the
 * choice was made, so the caller should resolve again with more time.
 */
export async function resolveGitCwd(
  cwd: string,
  goal: Pick<GoalRecord, "context"> | null,
  isRepo: (dir: string) => Promise<boolean> = isGitRepo,
): Promise<{ dir: string; settled: boolean }> {
  if (!goal) return { dir: cwd, settled: true };
  let settled = true;
  for (const item of goal.context) {
    if (item.kind !== "folder") continue;
    const repo = await isRepo(item.path).catch(() => null);
    if (repo === null) settled = false;
    if (repo) return { dir: item.path, settled };
  }
  return { dir: cwd, settled };
}

export interface GitState {
  branch: string | null;
  isRepo: boolean;
  dirtyFileCount: number;
  gitHubSlug: string | null;
  /**
   * False when git didn't answer whether this is a repo, or how many files
   * changed in one (a timeout on a busy machine): isRepo and dirtyFileCount
   * are then placeholders, and the caller should read again with more time.
   */
  settled: boolean;
}

/**
 * Read a folder's git state; each part falls back on its own when git fails.
 * `dirtyCount: false` skips the uncommitted-file count (`git status`, the slow
 * part): it reads as 0 and doesn't count against `settled`.
 */
export async function readGitState(
  dir: string,
  options: GitReadOptions = {},
  parts: { dirtyCount?: boolean } = {},
): Promise<GitState> {
  const countDirty = parts.dirtyCount !== false;
  const [branch, isRepo, dirtyFileCount, gitHubSlug] = await Promise.all([
    getGitBranch(dir, options).catch(() => null),
    isGitRepo(dir, options).catch(() => null),
    countDirty ? getGitDirtyFileCount(dir, options).catch(() => null) : null,
    getGitHubRepoSlug(dir).catch(() => null),
  ]);
  return {
    branch,
    isRepo: isRepo ?? false,
    dirtyFileCount: dirtyFileCount ?? 0,
    gitHubSlug,
    // Outside a repo the count fails by design; only a repo needs one.
    settled: isRepo === false || (isRepo === true && (!countDirty || dirtyFileCount !== null)),
  };
}

/** What the window knows when the deferred startup reads come back. */
export interface DeferredGitView {
  /** The folder git is read from now (a goal can retarget it meanwhile). */
  gitCwd: string;
  /** The window was torn down. */
  stopped: boolean;
  /** A poll, run or retarget already filled in the dirty count. */
  dirtyCountKnown: boolean;
  dirtyFileCount: number;
  worktreeOf: string | null;
}

/**
 * The footer-only git reads a window's startup skips (uncommitted-file count,
 * linked worktree's main folder), read once it is ready. Returns what to apply,
 * or null when nothing changed. A newer dirty count is never overwritten.
 * `dirtyFailed`: git gave no count, so the caller should re-read with more time.
 */
export async function settleDeferredGit(
  dir: string,
  read: {
    dirtyCount: (dir: string) => Promise<number>;
    worktreeOf: (dir: string) => Promise<string | null>;
  },
  view: () => DeferredGitView,
): Promise<{
  update: { dirtyFileCount?: number; worktreeOf: string | null } | null;
  dirtyFailed: boolean;
}> {
  const [dirty, mainCheckout] = await Promise.all([
    read.dirtyCount(dir).catch(() => null),
    read.worktreeOf(dir).catch(() => null),
  ]);
  const now = view();
  if (now.stopped) return { update: null, dirtyFailed: false };
  const update: { dirtyFileCount?: number; worktreeOf: string | null } = {
    worktreeOf: mainCheckout,
  };
  let changed = mainCheckout !== now.worktreeOf;
  if (dirty !== null && !now.dirtyCountKnown && now.gitCwd === dir) {
    update.dirtyFileCount = dirty;
    changed ||= dirty !== now.dirtyFileCount;
  }
  return { update: changed ? update : null, dirtyFailed: dirty === null };
}
