# ADR 0010: Worktree-isolated workers and a merge review

**Status:** Accepted, 2026-11-06.

## Context

Orchestrate, Ultracode and Goals fan work out to parallel children, and until
now every child shared the project checkout (ADR 0004 left isolation out of
scope). Two workers editing the same file overwrite each other, and a half-done
worker leaves the main folder dirty. Others already solve this the same way:
claude-squad gives each agent its own git worktree and branch; Claude Code has
`--worktree` and sub-agents with `isolation: worktree`; Cursor runs parallel
agents in worktrees and asks the user to apply each result. Israel Code already
had managed worktrees (`~/.israelcode/worktrees`, the Git panel's branch
picker, setup commands from `.gg/worktree.json`). What was missing was tying
them to workers and giving the user a review before the work lands.

## Decision

- **Isolation is per task.** `spawn_agent` tasks get an optional
  `isolation: "worktree"` (schema append-only). The Orchestrate notice tells the
  orchestrator to set it on every task that edits files and to review each
  worker's worktree diff before merging. `SubAgentManager` reads a
  `getWorktreePolicy()` at spawn time; when it is enabled it creates the
  worktree (`createWorkerWorktree`) on a `gg/worker/<slug>-<nonce>` branch cut
  from the main folder's branch, runs the child there, and records
  `worktree: {path, branch, base}` on the snapshot (persisted, so a restart
  still lists it). A child's cwd may be any worktree of the repository.
- **Managed folder.** Worker worktrees live under the same managed folder as
  the Git panel's (`~/.israelcode/worktrees/<repo>-<hash>/`), copy ignored
  local files (`.env` and the like), and start the project's setup command in
  the background.
- **WIP commit before diff and merge.** A worker's uncommitted changes are
  committed on its branch before a diff, a conflict preview or a merge, so
  nothing is left behind by a later step.
- **Squash by default.** Merging squashes the branch into one commit on the
  base in the main folder (`merge` makes a `--no-ff` merge commit instead). It
  is refused when the main folder has uncommitted changes to files the worker
  touched, and a conflicting merge is rolled back; both report the files.
- **Empty worktrees go away.** When a worker's turn ends with no uncommitted
  changes and no commits ahead, its process is stopped and its worktree and
  branch are removed. After every merge or discard, `pruneEmptyWorktrees`
  sweeps the rest.
- **Clean-and-verified auto-merge.** Per project (`worktreeWorkers` in
  gg-app.json, `{enabled, autoMerge: "never" | "clean-and-verified"}`, default
  on / never). With `clean-and-verified`, a worker that finishes with changes
  is previewed (no conflicts) and the project's verify commands run in its
  worktree; if both pass it is squash-merged, otherwise it stays for manual
  review with `autoMerge: {attempted, merged: false, reason}` on its row.
- **Three app layers.** Sidecar `/worktree-workers` routes (list, policy, diff,
  preview, verify, merge, discard; `worktree_workers_state` and
  `worktree_verify_progress` events), Rust proxies in
  `commands/worktree_workers.rs`, typed wrappers in `agent.ts`, a **Review
  worktrees** popover in the header and a worktree badge on sub-agent rows.

## Consequences

- Each worktree is a full checkout and runs its own dependency install, so a
  run with many workers costs disk and install time; empty ones are pruned at
  once, merged and discarded ones on the spot.
- Workers can no longer see each other's uncommitted edits; the orchestrator
  has to merge one before another builds on it.
- Merges happen in the main folder and are refused rather than forced when
  the user has overlapping uncommitted work.

## Follow-ups

- Goal windows run their critters without isolation for now: Goals has its own
  folder per goal and its own policy wiring, which come later.
- A rebase mode (rebase the worker branch on the base, then fast-forward) next
  to squash and merge.
