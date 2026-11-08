# ADR 0012: Closing a window does not stop its work

**Status:** Accepted, 2026-11-07.

## Context

Every window owns one in-process `AgentSession` in the shared sidecar daemon.
The Rust shell sent `DELETE /session/:id` when a window was destroyed or moved
to another project, and the daemon disposed the session, aborting its run. A
long refactor or a run-all sweep died the moment someone closed the window or
glanced at another conversation, and a question or approval waiting for an
answer was lost with it.

The daemon already outlives windows, a reloaded webview already rebuilds a
running session from the `ready` frame, and run state (`RunLifecycle`),
approvals, `ask_user` and pending plans all live on the context. What was
missing was a way to say "the window is gone, the work is not".

## Decision

- **Close is not stop.** `POST /session/:id/detach` means the window is gone.
  A busy context (run, queued prompt, sub-agent, autopilot cycle) or one that
  is waiting for the user stays in `sessions`, marked detached. An idle one is
  disposed exactly as `DELETE` does. `DELETE /session/:id` still means dispose
  now.
- **Stop is explicit.** `POST /background-sessions/stop` cancels the run
  through `cancelActiveRun`, the same code the window's Stop button uses.
  Nothing else terminates active work, apart from the daemon exiting.
- **Delete is separate again.** `POST /background-sessions/delete` stops the
  work, disposes the context, removes the row and deletes the conversation
  file, which must resolve inside the daemon's sessions folder.
- **Reattach.** `POST /session` with a `sessionPath` that matches a live,
  detached context (same mode, and same chat agent for chat) returns that
  context's id with `reattached: true`. No resume or checkout logic runs, no
  second context is made on the file, and nothing is re-executed. A context
  attached to another window keeps today's behaviour.
- **Awaiting input pauses, it does not expire.** A detached context waiting on
  an approval, a question or a plan review has no timer to disposal. Approvals
  never had a timeout. The `ask_user` soft deadline re-arms instead of firing
  while the context is detached (`isSuspended`), so the agent keeps waiting for
  the user to return. Attached and scheduled-run deadlines are unchanged.
- **Grace disposal.** A detached context that finishes with nothing pending is
  disposed after ten minutes (`BACKGROUND_GRACE_MS`), unless reattached first.
  Its final row stays.
- **Registry and persistence.** `BackgroundSessionRegistry`
  (`app-sidecar/background-sessions.ts`) reads each context's `status()`
  (`running`, `awaiting_input`, `completed`, `failed`, `cancelled`, `idle`,
  plus `interrupted` for rows from a dead daemon) and is notified when run
  state, approvals, questions or the plan change. Rows hold ids, paths, mode,
  status, a short detail and a title of at most 80 characters (the first user
  message), never conversation content or secrets, and are written atomically
  to `<agentDir>/background-sessions.json` (30 rows at most). Failure detail
  uses the same sanitized headline as `broadcastError`.
- **Routes.** `GET /background-sessions`, `POST /background-sessions/stop`,
  `/dismiss` and `/delete`. Changes are pushed to every window as a debounced
  `background_sessions` frame.

## What happens when…

- **A window is closed.** The shell detaches it. Running work continues;
  waiting work keeps waiting; idle sessions are disposed. The row appears in
  the background list.
- **A window switches to another conversation.** The same: the old session is
  detached, and opening it again reattaches to the live session.
- **The app quits.** The daemon exits and active work stops, because nothing
  runs without it. The rows are written first, so on the next start they show
  **Interrupted** ("Stopped when Israel Code closed"). Conversation history up
  to the last persisted message is kept and can be reopened. There is no
  auto-resume.
- **The backend crashes.** Same as quit. The app's existing daemon restart
  reconnects windows; rows left by the dead daemon become Interrupted.
- **The device restarts or sleeps.** Same as quit for a restart. Sleep pauses
  the process; keep-awake is a separate setting that prevents it during runs.

## Consequences

- A forgotten detached session can keep spending tokens until it finishes or
  the user stops it from the list; the list is the control.
- A session waiting for input holds its memory until someone answers, stops or
  deletes it.
- Work still ends with the daemon, so "background" means "without a window",
  not "without the app".
