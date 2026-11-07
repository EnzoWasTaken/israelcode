# ADR 0009: Compaction control — a rewind point, pins, a threshold and undo

**Status:** Accepted, 2026-11-06.

## Context

Every agent compacts its context automatically and every agent's users
complain about the same three things: it fires at a bad moment, it loses a
fact they cared about, and it cannot be undone. The ecosystem answers at the
edges. Claude Code offers a `PreCompact` hook so a script can save the
transcript before the summary replaces it; Engram-style memory servers take a
snapshot into an external store; threads ask for the reserve to be raised
because ~22 % of the window goes unused once the trigger is near. None of
them undo anything, and none let the user say what must survive.

Israel Code already had the pieces. `AgentSession.compact()` takes a `focus`
the summariser must keep verbatim (`/compact <focus>` in the CLI). Rewind
points (`CheckpointStore`) sit before each typed prompt and the picker can go
back to one. The trigger — `compactThreshold` × window or `compactAtTokens` —
lives in the global `settings.json`. What was missing was the glue and a
control the user can see.

## Decision

- **A rewind point before every compaction.** `compact()` opens a checkpoint
  labelled `Before compaction (N messages)` before anything changes
  (`openCompactionRewindPoint`, never throws, skipped when the session keeps
  no checkpoints). It lists in the rewind picker like any other point; its
  files can be restored from there.
- **Undo is in memory, not a rewind.** A conversation rewind cannot cross a
  compaction: the summary lives in a new session file with a new leaf, so the
  old leaf is "no longer here". `undoLastCompaction()` instead keeps the
  pre-compaction messages in memory and puts them back, persisting them as a
  new checkpoint (newest generation wins on resume). Nothing on disk is
  deleted; files are untouched. A daemon restart loses the undo option; the
  rewind point stays.
- **Pinned facts go through `focus`.** `getPinnedFacts?: () => string[]` on
  `AgentSession`; `buildCompactionFocus(pins, userFocus)` renders "Keep these
  facts verbatim:" + bullets, then the caller's focus. Automatic, post-turn
  and manual compactions all pass through the same merge.
- **Per-project trigger override.** `~/.israelcode/gg-app.json` gains
  `compaction: {projectKey: {threshold? (0.3–0.95), atTokens? (≥ 20k | null),
pins (≤ 20 × 200 chars)}}`. The sidecar applies it with
  `session.setCompactionOverride`; every read of the trigger goes through
  `compactThreshold()` / `compactAtTokens()`, which fall back to
  `settings.json`. `atTokens: null` drops the absolute trigger.
- **Three app layers.** Routes `GET /compaction` → `{pref, info}`,
  `POST /compaction` (`threshold?`, `atTokens?`, `pins?`; saves, applies,
  broadcasts `compaction_state`), `POST /compaction/compact` (`focus?`; inside
  the run lifecycle, 409 mid-run) and `POST /compaction/undo` (404 when none).
  `compaction` in `/state` and the ready frame; `compaction_state` also after
  every `compaction_end`. Rust `agent_get_compaction`, `agent_set_compaction`,
  `agent_compact_now`, `agent_undo_compaction`; wrappers `getCompaction`,
  `setCompaction`, `compactNow`, `undoCompaction`.
- **The gauge is the control.** The deck's context gauge becomes a button
  (`CompactionControl.tsx`): usage `N% of <window>k`, presets 60/70/85 % or a
  token count, the pins (one per line, saved after a pause), Compact now and
  Undo last compaction. The compaction notice row says where undo lives.

## Consequences

- Pins cost tokens on every compaction's summary and, kept verbatim, in every
  later turn; the caps (20 × 200 chars) bound that at about 1k tokens.
- A lower threshold compacts more often and loses more; the user chose it per
  project and can see the trigger next to the usage.
- Undo restores the conversation, not the model's cache: the next turn is a
  cold prefix. It also grows the session folder by one checkpoint per undo.
- Chat, Motion and Goal windows have no control; their compaction is as before.

## Out of scope

- Undo after a daemon restart (would need the pre-compaction file as a
  resumable checkpoint rather than a parent generation).
- Editing the summary by hand, or choosing which messages the summariser keeps.
- A global default for the threshold in the app: `settings.json` remains the
  CLI's and the fallback.
