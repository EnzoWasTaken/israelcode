# ADR 0007: The verify loop — test-and-fix with a cap

**Status:** Accepted, 2026-11-06.

## Context

An agent that edits code and replies "done" has not shown the code works. The
system prompt already recommends the project's checks (`core/verify-commands.ts`
detects them from manifests) and the verification gate nags when none ran, but
whether the model obeys is up to the model. The ecosystem has settled on
making the tool do it: Aider's `--auto-test` runs the test command after each
edit and feeds failures back; "ralph loops" re-prompt until a check passes;
Claude Code users wire tests into `PostToolUse` hooks. Each does the right
thing and each is unbounded or glued on from outside. Israel Code had the
pieces — a user-shell runner with redaction and a bounded tail
(`app-sidecar/shell-runs.ts`), hidden runtime prompts (autopilot's
injections), the run lifecycle behind the Stop button — but no loop.

## Decision

- **Israel Code runs the checks, not the model.** After a user turn that
  wrote files (tool calls to `write`/`edit`/…; shell commands don't count) in a
  coding session that is not in plan mode and has no plan pending, the sidecar
  runs the project's verify commands in order with the user's own shell
  (`runShellCommandOnce`: 10-minute cap per command, last 200 lines / 16k
  chars, secrets redacted). This happens before Autopilot's review, so the
  reviewer judges fixed code.
- **Failures go back as a hidden fix round.** Only the failing checks' output
  is sent, as a runtime/automation/hidden prompt inside the same run
  (`buildVerifyFixMessage`): "Fix the cause (not the test, unless the test
  itself is wrong), re-run the failing check, then stop." Then the checks run
  again.
- **`maxRounds` counts check rounds**, default 3, cap 10. Round 1 is the first
  check; each failing round short of the last is followed by one fix round.
  Default 3 therefore means at most two fixes; `1` means check and report
  only. The loop ends on the first all-green round.
- **Engine is pure** (`core/verify-loop.ts`): config, message, orchestration
  with injected `runCommand`/`fixRound`. The controller (`app-sidecar/verify.ts`)
  plugs in the shell and `session.prompt`; the Stop button's `abortOwnedWork`
  calls `verify.cancel()`, which kills the running check's process tree and
  ends the loop as `cancelled`.
- **Two files.** The per-project switch lives in `~/.israelcode/gg-app.json`
  (`verify: {projectKey: {enabled}}`, off by default). The commands and the cap
  live in `<project>/.gg/verify.json` (`{version:1, commands:[{label,command}],
maxRounds}`), shared through git; without it, the test / typecheck / lint
  commands the manifests promise are used (`source: "detected"`).
- **Three app layers, as always.** Routes `GET /verify`, `POST /verify`
  (`enabled?`, `commands?`, `maxRounds?`), `POST /verify/run` (409 during a
  run); `verify` in `/state` and the ready frame; events `verify_state`,
  `verify_progress {round, maxRounds, label, command, status, exitCode?,
durationMs?, tail?}`, `verify_result {passed, rounds, stoppedReason}`. The
  result is persisted as a `verify` app marker so a reopened window shows the
  row. Rust `agent_get_verify`, `agent_set_verify`, `agent_run_verify`;
  wrappers `getVerify`, `setVerify`, `runVerify`.
- **UI.** A Verify switch in the deck next to Orchestrate, a settings key
  with the `label: command` list, the rounds and "Run checks now"
  (`VerifyControl.tsx`), and one transcript row per loop (`VerifyStrip.tsx`):
  a block per round, a line per check with mark and exit code, output behind a
  disclosure, and a closing line — green on round r, still failing after n
  rounds, or stopped.

## Consequences

- Each fix round is a full model turn with the failing output in context; a
  stubborn failure costs up to `maxRounds − 1` extra turns. The cap, not the
  model, ends it, and the strip shows every round's result.
- A flaky test makes the loop fix what isn't broken, or report "still failing"
  on green code. The message tells the model not to edit tests unless they are
  wrong; the user can drop the check from `.gg/verify.json`.
- A long test suite delays Autopilot's review and the reply's settlement by
  its run time. The loop is off until the user turns it on per project.
- A check that times out counts as a failure (its tail says so), not as a
  user Stop.

## Out of scope

- Watch mode or running checks during a turn: the loop runs once the agent
  has stopped editing.
- Skipping checks the agent already ran this turn (`getRunVerificationActivity`
  evidence): the loop is authoritative and always runs the configured list.
- Per-file or changed-only test selection; the commands run as written.
