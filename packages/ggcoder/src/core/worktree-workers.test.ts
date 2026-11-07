import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorktreeWorkerError,
  createWorkerWorktree,
  discardWorker,
  mergeWorker,
  parseMergeTreeConflicts,
  previewMerge,
  pruneEmptyWorktrees,
  workerBranchName,
  workerNameFromBranch,
  worktreeDiff,
  worktreeStatus,
} from "./worktree-workers.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Read a file with line endings normalised (core.autocrlf may be on). */
const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

let root: string;
let repo: string;
let managed: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gg-wt-workers-")));
  repo = path.join(root, "app");
  managed = path.join(root, "gg-worktrees");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  // Worktree folders are gone (git removed them) before rm, so no EBUSY here.
  fs.rmSync(root, { recursive: true, force: true });
});

const make = (name = "Fix parser", agentName?: string) =>
  createWorkerWorktree({ repoRoot: repo, name, agentName, managedRoot: managed, setup: false });

describe("workerBranchName", () => {
  it("slugs the agent and task into gg/worker/<slug>-<nonce>", () => {
    expect(workerBranchName("builder", "Fix the Parser!", "a1b2c3")).toBe(
      "gg/worker/builder-fix-the-parser-a1b2c3",
    );
    expect(workerBranchName(undefined, "***", "ABC123")).toBe("gg/worker/task-abc123");
    expect(workerNameFromBranch("gg/worker/builder-fix-the-parser-a1b2c3")).toBe(
      "builder-fix-the-parser",
    );
  });
});

describe("createWorkerWorktree", () => {
  it("adds a managed worktree on a fresh branch cut from the current branch", async () => {
    const wt = await make("Fix parser", "builder");
    expect(wt.base).toBe("main");
    expect(wt.branch).toMatch(/^gg\/worker\/builder-fix-parser-[0-9a-f]{6}$/);
    expect(wt.path.startsWith(managed)).toBe(true);
    expect(fs.existsSync(path.join(wt.path, "a.txt"))).toBe(true);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(wt.branch);
    expect(await worktreeStatus(wt.path, wt.base)).toEqual({
      dirty: 0,
      ahead: 0,
      changedFiles: 0,
    });
  });

  it("refuses outside a git repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    await expect(
      createWorkerWorktree({ repoRoot: plain, name: "x", managedRoot: managed, setup: false }),
    ).rejects.toBeInstanceOf(WorktreeWorkerError);
  });
});

describe("worktreeStatus and worktreeDiff", () => {
  it("counts uncommitted and committed changes, then diffs after committing WIP", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "a.txt"), "a\nmore\n");
    fs.writeFileSync(path.join(wt.path, "new.txt"), "n\n");
    expect(await worktreeStatus(wt.path, wt.base)).toEqual({
      dirty: 2,
      ahead: 0,
      changedFiles: 2,
    });

    const diff = await worktreeDiff(repo, wt);
    expect(diff.files).toEqual([
      { path: "a.txt", status: "M", additions: 1, deletions: 0 },
      { path: "new.txt", status: "A", additions: 1, deletions: 0 },
    ]);
    expect(diff.patch).toContain("+more");
    expect(diff.truncated).toBe(false);
    // WIP commit landed on the worker's branch, so nothing is left uncommitted.
    expect(git(wt.path, "log", "-1", "--format=%s").trim()).toBe(
      `WIP: worker ${workerNameFromBranch(wt.branch)}`,
    );
    expect(await worktreeStatus(wt.path, wt.base)).toEqual({
      dirty: 0,
      ahead: 1,
      changedFiles: 2,
    });
  });

  it("diffs against the merge-base, so commits on main after the fork do not count", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(repo, "b.txt"), "b\nmain moved\n");
    git(repo, "commit", "-q", "-am", "main work");
    fs.writeFileSync(path.join(wt.path, "a.txt"), "worker\n");
    const diff = await worktreeDiff(repo, wt);
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});

describe("previewMerge", () => {
  it("parses merge-tree output and reports conflicts without touching the main folder", async () => {
    expect(parseMergeTreeConflicts("oid\0f\0g\0\0Auto-merging f\0")).toEqual(["f", "g"]);
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "a.txt"), "worker\n");
    expect(await previewMerge(repo, wt.branch)).toEqual({ conflicts: [] });
    fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main a");
    expect(await previewMerge(repo, wt.branch)).toEqual({ conflicts: ["a.txt"] });
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });
});

describe("mergeWorker", () => {
  it("squashes the worker's commits into the base and reports the commit", async () => {
    const wt = await make("Add feature");
    fs.writeFileSync(path.join(wt.path, "new.txt"), "n\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(wt.path, "new.txt"), "n\nmore\n");
    const result = await mergeWorker({ repoRoot: repo, branch: wt.branch, mode: "squash" });
    expect(result.merged).toBe(true);
    expect(result.commit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(read(path.join(repo, "new.txt"))).toBe("n\nmore\n");
    expect(git(repo, "log", "--format=%s").trim().split("\n")).toEqual([
      `Merge worker ${workerNameFromBranch(wt.branch)} (${wt.branch})`,
      "init",
    ]);
  });

  it("makes a merge commit in merge mode with the given message", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "new.txt"), "n\n");
    await mergeWorker({ repoRoot: repo, branch: wt.branch, mode: "merge", message: "Land it" });
    expect(git(repo, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("Land it");
  });

  it("refuses when the main folder has uncommitted changes to the same files", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "a.txt"), "worker\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "local edit\n");
    const error = await mergeWorker({ repoRoot: repo, branch: wt.branch, mode: "squash" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorktreeWorkerError);
    expect((error as WorktreeWorkerError).files).toEqual(["a.txt"]);
    expect(read(path.join(repo, "a.txt"))).toBe("local edit\n");
  });

  it("rolls back a conflicting merge and names the files", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "a.txt"), "worker\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main a");
    const error = await mergeWorker({ repoRoot: repo, branch: wt.branch, mode: "squash" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorktreeWorkerError);
    expect((error as WorktreeWorkerError).files).toEqual(["a.txt"]);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(read(path.join(repo, "a.txt"))).toBe("main\n");
  });

  it("refuses a branch with nothing to merge", async () => {
    const wt = await make();
    await expect(
      mergeWorker({ repoRoot: repo, branch: wt.branch, mode: "squash" }),
    ).rejects.toThrow(/no changes/);
  });
});

describe("discardWorker and pruneEmptyWorktrees", () => {
  it("removes the worktree folder and the branch", async () => {
    const wt = await make();
    fs.writeFileSync(path.join(wt.path, "junk.txt"), "x\n");
    await discardWorker({ repoRoot: repo, path: wt.path, branch: wt.branch });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", wt.branch).trim()).toBe("");
    expect(fs.existsSync(path.dirname(wt.path))).toBe(false);
  });

  it("prunes only worker worktrees that have no changes", async () => {
    const empty = await make("empty");
    const busy = await make("busy");
    fs.writeFileSync(path.join(busy.path, "w.txt"), "w\n");
    const own = path.join(root, "own");
    git(repo, "worktree", "add", "-q", "-b", "own", own);
    expect(await pruneEmptyWorktrees(repo, managed)).toEqual([empty.branch]);
    expect(fs.existsSync(empty.path)).toBe(false);
    expect(fs.existsSync(busy.path)).toBe(true);
    expect(fs.existsSync(own)).toBe(true);
  });
});
