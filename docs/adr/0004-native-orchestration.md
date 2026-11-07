# ADR 0004: Native orchestration with a Worker model per project

**Status:** Accepted, 2026-11-06.

## Context

Running a strong model for planning and a cheaper or faster one for the bulk of
the edits is now ordinary practice, but every tool makes the user wire it by
hand: Claude Code's `opusplan` alias, claude-code-router's per-task routing
config, Roo Code's per-mode model pick. In Israel Code the pieces already
existed and were not joined: `spawn_agent` children can run on a different
model (`getChildModel` on `AgentSession`, used by GG Goals to put its critters
on their own pick), and Ultracode already teaches the main model to plan, split
the work into parallel children, review and combine. What was missing was a
way for a code window to say "this project's workers run on model X" and a
switch that turns the plan → delegate → review loop on without a Goal.

## Decision

- **Two roles, one window.** The Orchestrator is the window's main model,
  unchanged. The **Worker** model is a per-project pick that every child
  started by `spawn_agent` runs on; unset, workers follow the main model.
- **Reuse, don't fork.** The engine piece (`packages/ggcoder/src/core/orchestration.ts`)
  mirrors Ultracode: switching Orchestrate on or off appends one hidden
  runtime notice (`buildOrchestrateMessage`, deduplicated against the last
  notice in the history by `lastOrchestrateState`) and raises the concurrent
  child cap to `ULTRACODE_ACTIVE_LIMIT` (12) while on. **The cached system
  prompt is never re-rendered** for it. The Worker model reaches children
  through the existing `getChildModel` hook in `AgentSession`; the sidecar's
  session context holds the pick (`ctx.workerModel`) so a change applies to
  the next child without restarting the session.
- **Persistence** is in `~/.israelcode/gg-app.json`, read by the sidecar
  (`app-sidecar/app-settings.ts`): `workerModels` keyed per project
  (`{ provider, model }`) and a single `orchestrate` new-session default. A
  stale pin (model gone, provider changed or no longer connected) is logged
  and ignored at session start (`resolveWorkerPick`), so workers quietly
  follow the orchestrator rather than fail.
- **Worker validation is the critters' rule** (`workerPickBlocker`, shared by
  session start and the route): a known model, a provider the user is signed
  in to, and never a paid tier (workers run unwatched in parallel). The
  route refuses a paid pick with a plain message; a saved pin is read back
  through `withoutPaidTier` so an old one cannot smuggle a tier in.
- **Three app layers, as always.** Sidecar routes `POST /orchestration/worker-model`
  (`{ model: string | null }`) and `POST /orchestration/toggle` (`{ on }`),
  refused outside a coding session (`app-sidecar/orchestration-routes.ts`);
  Rust proxies `agent_set_worker_model` and `agent_set_orchestrate`
  (`gg-app/src-tauri/src/commands/orchestration.rs`); typed wrappers
  `setWorkerModel` and `setOrchestrate` in `gg-app/src/agent.ts`, with
  `AgentState.orchestration` kept current by the window's `orchestration_state`
  event. Other windows on the same project pick the saved value up when their
  next session starts.
- **UI.** The model panel gains a third target, **Workers**, next to Israel
  Code and Israel, with the same "Follow Israel Code" row and the same
  paid-tier lockout. The header gets an **Orchestrate** switch beside
  Ultracode whose tooltip names both models. A sub-agent row names the
  worker's model when it differs from the main one. An Orchestrate turn
  reuses Ultracode's phase strip (plan → build → review → combine). Typing
  `orchestrate` in a prompt, like `ultracode`, arms it for that run only.

## Consequences

- The orchestrator reviews every worker result (reads the diff, runs the
  checks, sends fix rounds) before replying, so a run costs more main-model
  tokens than a direct answer; the notice tells it to stay direct for small
  jobs, and the toggle is off by default.
- Because the notice is appended rather than rendered into the system prompt,
  the prefix cache survives toggling, and a turn that started with Orchestrate
  off is not retroactively changed.
- A cleared or invalid worker pin degrades to "follow the main model" with a
  log line, not an error in the chat; the Workers target shows `= Israel Code`
  so the user can see it.
- Goal windows keep their own critters pick; the routes return 404 there, and
  the model panel shows no Workers target.

## Out of scope

- Role-based routing by task kind (a model for tests, another for docs) — a
  later feature; today there is one Worker model per project.
- Cost or token accounting per role beyond what the sub-agent rows already
  show.
- Worktree or branch isolation per worker; children share the project
  checkout as Ultracode's do.
