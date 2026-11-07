import { existsSync } from "node:fs";
import { log } from "../core/logger.js";
import type { SubAgentSnapshot, WorktreePolicy } from "../core/subagent-manager.js";
import { loadVerifyConfig, type VerifyCommandSpec } from "../core/verify-loop.js";
import {
  discardWorker,
  mergeWorker,
  previewMerge,
  pruneEmptyWorktrees,
  worktreeDiff,
  worktreeStatus,
  type WorktreeDiff,
  type WorktreeStatus,
} from "../core/worktree-workers.js";
import type { WorktreeWorkersPref } from "./app-settings.js";
import { runShellCommandOnce } from "./shell-runs.js";

/**
 * Merge review for worktree-isolated workers (one coding window): lists the
 * workers that have their own worktree, shows each one's diff and conflict
 * preview, runs the project's checks inside it, and merges or discards it.
 */

/** One isolated worker as the app sees it. */
export interface WorktreeWorkerRow {
  agentId: string;
  name: string;
  branch: string;
  path: string;
  base: string;
  status: WorktreeStatus;
  childState: SubAgentSnapshot["state"];
  /** The last automatic merge attempt (autoMerge "clean-and-verified"), when one ran. */
  autoMerge?: AutoMergeOutcome;
}

export interface AutoMergeOutcome {
  attempted: true;
  merged: boolean;
  /** Why it was left for manual review. */
  reason?: string;
}

/** What `GET /worktree-workers` and `worktree_workers_state` carry. */
export interface WorktreeWorkersPayload {
  pref: WorktreeWorkersPref;
  workers: WorktreeWorkerRow[];
}

export interface WorktreeVerifyResult {
  label: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  tail: string;
}

/** A review action refused for the user (status + message, optional files). */
export class WorktreeReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly files?: readonly string[],
  ) {
    super(message);
  }
}

export interface WorktreeReviewController {
  readonly pref: WorktreeWorkersPref;
  /** The SubAgentManager's isolation policy; undefined outside a git repo. */
  policy(): WorktreePolicy | undefined;
  statePayload(): Promise<WorktreeWorkersPayload>;
  /** Apply a saved pref and broadcast the new state. */
  setPref(pref: WorktreeWorkersPref): Promise<WorktreeWorkersPayload>;
  /** Broadcast `worktree_workers_state` (a worker worktree appeared or went). */
  announce(): Promise<void>;
  /** Broadcast only when the set of worker worktrees changed since the last call. */
  noteSubAgentState(snapshot: SubAgentSnapshot): void;
  /** Resolves once every automatic merge attempt in flight has settled (tests). */
  waitForAutoMerge(): Promise<void>;
  diff(branch: string): Promise<WorktreeDiff>;
  preview(branch: string): Promise<{ conflicts: string[] }>;
  verify(branch: string): Promise<{ passed: boolean; results: WorktreeVerifyResult[] }>;
  merge(branch: string, mode: "squash" | "merge"): Promise<{ merged: true; commit: string }>;
  discard(branch: string): Promise<{ discarded: true }>;
}

export function createWorktreeReviewController(opts: {
  cwd: string;
  /** The repository's folder, or null when the project isn't a git repo. */
  repoRoot: string | null;
  managedRoot: string;
  pref: WorktreeWorkersPref;
  listSubAgents: () => SubAgentSnapshot[];
  broadcast: (type: string, data: unknown) => void;
  runCommand?: typeof runShellCommandOnce;
}): WorktreeReviewController {
  let pref = opts.pref;
  const run = opts.runCommand ?? runShellCommandOnce;
  const known = new Map<string, string>(); // agentId → branch
  const autoMerges = new Map<string, AutoMergeOutcome>(); // agentId → last attempt
  const autoMergedTurns = new Set<string>(); // `${agentId}:${turn}` already tried
  const autoMergeRuns = new Set<Promise<void>>();

  const isolated = (): Array<
    SubAgentSnapshot & { worktree: NonNullable<SubAgentSnapshot["worktree"]> }
  > =>
    opts
      .listSubAgents()
      .filter(
        (s): s is SubAgentSnapshot & { worktree: NonNullable<SubAgentSnapshot["worktree"]> } =>
          !!s.worktree && existsSync(s.worktree.path),
      );

  const requireRepo = (): string => {
    if (!opts.repoRoot) throw new WorktreeReviewError(404, "This project isn't a git repository.");
    return opts.repoRoot;
  };

  const find = (branch: string) => {
    requireRepo();
    const worker = isolated().find((s) => s.worktree.branch === branch);
    if (!worker) throw new WorktreeReviewError(404, `No worker worktree on branch ${branch}.`);
    return worker;
  };

  const requireIdle = (worker: SubAgentSnapshot): void => {
    if (worker.state === "starting" || worker.state === "running") {
      throw new WorktreeReviewError(409, "This worker is still running. Wait for it to finish.");
    }
  };

  const statePayload = async (): Promise<WorktreeWorkersPayload> => {
    const workers = await Promise.all(
      isolated().map(async (s): Promise<WorktreeWorkerRow> => ({
        agentId: s.agent_id,
        name: s.task_name,
        branch: s.worktree.branch,
        path: s.worktree.path,
        base: s.worktree.base,
        status: await worktreeStatus(s.worktree.path, s.worktree.base).catch(() => ({
          dirty: 0,
          ahead: 0,
          changedFiles: 0,
        })),
        childState: s.state,
        ...(autoMerges.has(s.agent_id) && { autoMerge: { ...autoMerges.get(s.agent_id)! } }),
      })),
    );
    return { pref: { ...pref }, workers };
  };

  const announce = async (): Promise<void> => {
    try {
      opts.broadcast("worktree_workers_state", await statePayload());
    } catch (error) {
      log("WARN", "worktree-review", "worktree workers state failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const pruneAndAnnounce = async (): Promise<void> => {
    if (opts.repoRoot) {
      await pruneEmptyWorktrees(opts.repoRoot, opts.managedRoot).catch(() => []);
    }
    await announce();
  };

  /** autoMerge "clean-and-verified": no conflicts and every check passes → squash merge. */
  const autoMerge = async (snapshot: SubAgentSnapshot): Promise<void> => {
    const worktree = snapshot.worktree;
    if (!worktree || !opts.repoRoot) return;
    const status = await worktreeStatus(worktree.path, worktree.base);
    if (status.dirty === 0 && status.ahead === 0) return; // the manager drops it
    let outcome: AutoMergeOutcome;
    try {
      const { conflicts } = await controller.preview(worktree.branch);
      if (conflicts.length > 0) {
        outcome = {
          attempted: true,
          merged: false,
          reason: `Conflicts in ${conflicts.join(", ")}`,
        };
      } else {
        const checks = await controller.verify(worktree.branch);
        const failed = checks.results.filter((r) => !r.passed).map((r) => r.label);
        if (failed.length > 0) {
          outcome = {
            attempted: true,
            merged: false,
            reason: `Checks failed: ${failed.join(", ")}`,
          };
        } else {
          autoMerges.delete(snapshot.agent_id);
          const result = await controller.merge(worktree.branch, "squash");
          log("INFO", "worktree-review", "worker auto-merged", {
            branch: worktree.branch,
            commit: result.commit,
          });
          return;
        }
      }
    } catch (error) {
      outcome = {
        attempted: true,
        merged: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    autoMerges.set(snapshot.agent_id, outcome);
    await announce();
  };

  const controller: WorktreeReviewController = {
    waitForAutoMerge: async () => {
      while (autoMergeRuns.size > 0) await Promise.all([...autoMergeRuns]);
    },
    get pref() {
      return pref;
    },
    policy() {
      if (!opts.repoRoot) return undefined;
      return { enabled: pref.enabled, repoRoot: opts.repoRoot, managedRoot: opts.managedRoot };
    },
    statePayload,
    async setPref(next) {
      pref = next;
      const payload = await statePayload();
      opts.broadcast("worktree_workers_state", payload);
      return payload;
    },
    announce,
    noteSubAgentState(snapshot) {
      const branch = snapshot.worktree?.branch;
      const turnKey = `${snapshot.agent_id}:${snapshot.turn_count}`;
      if (
        branch &&
        snapshot.state === "completed" &&
        pref.enabled &&
        pref.autoMerge === "clean-and-verified" &&
        !autoMergedTurns.has(turnKey)
      ) {
        autoMergedTurns.add(turnKey);
        const run = autoMerge(snapshot)
          .catch(() => {})
          .finally(() => autoMergeRuns.delete(run));
        autoMergeRuns.add(run);
      }
      if (known.get(snapshot.agent_id) === branch) return;
      if (branch) known.set(snapshot.agent_id, branch);
      else {
        known.delete(snapshot.agent_id);
        autoMerges.delete(snapshot.agent_id);
      }
      void announce();
    },
    async diff(branch) {
      const worker = find(branch);
      return worktreeDiff(requireRepo(), worker.worktree);
    },
    async preview(branch) {
      find(branch);
      return previewMerge(requireRepo(), branch);
    },
    async verify(branch) {
      const worker = find(branch);
      requireIdle(worker);
      const commands: VerifyCommandSpec[] = (await loadVerifyConfig(opts.cwd)).commands;
      const results: WorktreeVerifyResult[] = [];
      for (const { label, command } of commands) {
        opts.broadcast("worktree_verify_progress", { branch, label, status: "running" });
        const outcome = await run({ cwd: worker.worktree.path, command });
        const passed = outcome.exitCode === 0 && !outcome.cancelled && !outcome.timedOut;
        const tail = outcome.tail.slice(-4_000);
        results.push({ label, command, passed, exitCode: outcome.exitCode, tail });
        opts.broadcast("worktree_verify_progress", {
          branch,
          label,
          status: passed ? "passed" : "failed",
          ...(outcome.exitCode !== null && { exitCode: outcome.exitCode }),
          ...(!passed && { tail }),
        });
      }
      return { passed: results.every((r) => r.passed), results };
    },
    async merge(branch, mode) {
      const worker = find(branch);
      requireIdle(worker);
      const repoRoot = requireRepo();
      const result = await mergeWorker({ repoRoot, branch, mode });
      await discardWorker({ repoRoot, path: worker.worktree.path, branch }).catch((error) => {
        log("WARN", "worktree-review", "merged worker's worktree not removed", {
          branch,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await pruneAndAnnounce();
      return result;
    },
    async discard(branch) {
      const worker = find(branch);
      requireIdle(worker);
      await discardWorker({ repoRoot: requireRepo(), path: worker.worktree.path, branch });
      await pruneAndAnnounce();
      return { discarded: true };
    },
  };
  return controller;
}
