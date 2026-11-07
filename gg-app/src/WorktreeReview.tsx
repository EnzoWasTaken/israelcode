import { useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  setWorktreeWorkers,
  worktreeDiff,
  worktreeDiscard,
  worktreeMerge,
  worktreePreview,
  worktreeVerify,
  type WorktreeDiff,
  type WorktreeVerifyProgress,
  type WorktreeWorkerRow,
  type WorktreeWorkersPref,
  type WorktreeWorkersState,
} from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover } from "./popover";
import { toast } from "./toast";

type WorktreeWorkers = { pref: WorktreeWorkersPref; workers?: WorktreeWorkerRow[] };

/**
 * Merge review for worktree-isolated workers: the policy (isolation on/off,
 * auto-merge) and one row per worker worktree with Diff, Check conflicts,
 * Run checks, Merge (squash) and Discard.
 */
export function WorktreeReview({
  state,
  progress = {},
  onChange,
}: {
  state: WorktreeWorkers;
  /** `worktree_verify_progress` rows by branch. */
  progress?: Record<string, WorktreeVerifyProgress[]>;
  onChange: (next: WorktreeWorkersState) => void;
}): React.ReactElement {
  const selectId = useId();
  const workers = state.workers ?? [];

  async function savePref(change: Partial<WorktreeWorkersPref>): Promise<void> {
    try {
      onChange(await setWorktreeWorkers(change));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <div className="wt-review">
      <div className="wt-policy">
        <button
          type="button"
          className="key key-sm"
          role="switch"
          aria-checked={state.pref.enabled}
          title="Give each worker that edits files its own git worktree"
          onClick={() => void savePref({ enabled: !state.pref.enabled })}
        >
          Worktree workers
          <span
            className="led"
            data-state={state.pref.enabled ? "on" : undefined}
            aria-hidden="true"
          />
        </button>
        <label className="wt-field" htmlFor={selectId}>
          Auto-merge
          <select
            id={selectId}
            value={state.pref.autoMerge}
            onChange={(e) =>
              void savePref({ autoMerge: e.target.value as WorktreeWorkersPref["autoMerge"] })
            }
          >
            <option value="never">Never</option>
            <option value="clean-and-verified">When clean and checks pass</option>
          </select>
        </label>
      </div>
      {workers.length === 0 ? (
        <p className="wt-empty">No worker worktrees to review.</p>
      ) : (
        <ul className="wt-list">
          {workers.map((w) => (
            <WorkerRow key={w.branch} worker={w} progress={progress[w.branch] ?? []} />
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkerRow({
  worker,
  progress,
}: {
  worker: WorktreeWorkerRow;
  progress: WorktreeVerifyProgress[];
}): React.ReactElement {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<"merge" | "discard" | null>(null);
  const [busy, setBusy] = useState(false);
  const running = worker.childState === "starting" || worker.childState === "running";

  async function act<T>(run: () => Promise<T>, done: (value: T) => void): Promise<void> {
    setBusy(true);
    try {
      done(await run());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="wt-row">
      <div className="wt-row-head">
        <strong>{worker.name}</strong>
        <code className="wt-branch">{worker.branch}</code>
        <span className="wt-meta">
          {worker.status.changedFiles} {worker.status.changedFiles === 1 ? "file" : "files"} ·{" "}
          {worker.status.ahead} ahead · {worker.childState}
        </span>
      </div>
      {worker.autoMerge && !worker.autoMerge.merged && worker.autoMerge.reason && (
        <p className="wt-reason">Not auto-merged: {worker.autoMerge.reason}</p>
      )}
      <div className="wt-actions">
        <button
          type="button"
          className="key key-sm"
          aria-expanded={diff !== null}
          disabled={busy}
          onClick={() =>
            diff ? setDiff(null) : void act(() => worktreeDiff(worker.branch), setDiff)
          }
        >
          Diff
        </button>
        <button
          type="button"
          className="key key-sm"
          disabled={busy}
          onClick={() =>
            void act(
              () => worktreePreview(worker.branch),
              (r) => setConflicts(r.conflicts),
            )
          }
        >
          Check conflicts
        </button>
        <button
          type="button"
          className="key key-sm"
          disabled={busy || running || checking}
          onClick={() => {
            setChecking(true);
            void act(
              () => worktreeVerify(worker.branch),
              (r) =>
                toast(
                  r.passed ? "All checks passed." : "Some checks failed.",
                  r.passed ? "success" : "error",
                ),
            ).finally(() => setChecking(false));
          }}
        >
          Run checks
        </button>
        <button
          type="button"
          className="key key-sm"
          disabled={busy || running || (conflicts?.length ?? 0) > 0}
          title={running ? "Wait for the worker to finish" : undefined}
          onClick={() => setConfirm("merge")}
        >
          Merge
        </button>
        <button
          type="button"
          className="key key-sm"
          disabled={busy || running}
          onClick={() => setConfirm("discard")}
        >
          Discard
        </button>
      </div>
      {confirm && (
        <div className="wt-confirm" role="alertdialog" aria-label={`Confirm ${confirm}`}>
          <span>
            {confirm === "merge"
              ? `Squash-merge ${worker.branch} into ${worker.base}?`
              : `Delete ${worker.branch} and its worktree? Its changes are lost.`}
          </span>
          <button
            type="button"
            className="key key-sm"
            disabled={busy}
            onClick={() =>
              void act<unknown>(
                () =>
                  confirm === "merge"
                    ? worktreeMerge(worker.branch, "squash")
                    : worktreeDiscard(worker.branch),
                () => {
                  setConfirm(null);
                  toast(confirm === "merge" ? "Merged." : "Discarded.", "success");
                },
              )
            }
          >
            {confirm === "merge" ? "Confirm merge" : "Confirm discard"}
          </button>
          <button type="button" className="key key-sm" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      {conflicts && (
        <p className="wt-conflicts">
          {conflicts.length === 0 ? "No conflicts" : `Conflicts: ${conflicts.join(", ")}`}
        </p>
      )}
      {progress.length > 0 && (
        <ul className="wt-checks">
          {progress.map((p) => (
            <li key={p.label} data-status={p.status}>
              {p.label}: {p.status}
              {p.exitCode !== undefined && p.status === "failed" ? ` (exit ${p.exitCode})` : ""}
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="wt-diff">
          <ul className="wt-files">
            {diff.files.map((f) => (
              <li key={f.path}>
                <code>{f.status}</code> {f.path} +{f.additions} −{f.deletions}
              </li>
            ))}
          </ul>
          <pre className="wt-patch">{diff.patch}</pre>
          {diff.truncated && (
            <p className="wt-note">Diff truncated; open the worktree to see it all.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** The header key that opens the merge review popover (code windows). */
export function WorktreeReviewControl({
  state,
  progress,
  onChange,
}: {
  state: WorktreeWorkers;
  progress?: Record<string, WorktreeVerifyProgress[]>;
  onChange: (next: WorktreeWorkersState) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const popoverId = useId();
  const count = state.workers?.length ?? 0;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="key key-sm"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title="Review the workers' worktrees: diff, conflicts, checks, merge or discard"
        onClick={() => setOpen((v) => !v)}
      >
        Review worktrees{count > 0 ? ` (${count})` : ""}
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel wt-popover"
              data-side="below"
              role="dialog"
              aria-label="Worktree review"
              style={style}
            >
              <h2 className="pop-title">Worktree review</h2>
              <WorktreeReview state={state} progress={progress} onChange={onChange} />
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}
