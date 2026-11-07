# ADR 0006: Budget guardrails and a runaway-loop breaker

**Status:** Accepted, 2026-11-06.

## Context

Agent sessions can spend far more than the user meant to. Two patterns keep
coming up: a long Ultracode or Orchestrate run that quietly works through
millions of tokens, and a stuck run that retries the same failing command for
an hour. The ecosystem answers the first with after-the-fact dashboards
(ccusage reads Claude Code's logs) and the second with nothing; Claude Code's
`--max-budget-usd` only applies in print mode, not interactive sessions. Israel
Code already had the ingredients: every turn's usage is recorded as an
authoritative `TurnMetricPayload` (`AgentSession.getTurnMetrics`), children
report cumulative `token_usage` on their `subagent_state` snapshots, and the
loop-breaker (`core/loop-breaker.ts`) detects stuck runs — but it only nudges
the model, twice, and never stops anything.

There is no authoritative USD pricing in the engine (`cost.status` is always
`unavailable` by design), so a budget in dollars would be a guess.

## Decision

- **Budgets are in tokens**, never dollars: input + output per turn. Two caps
  per project, a **session cap** (this window's session) and a **day cap**
  (the project across windows, local calendar day). Warnings at 50% and 80% of
  each cap fire once; at 100% the run is stopped. **Continue anyway** lifts the
  caps for the rest of the session; setting caps again re-arms.
- **Engine piece is pure.** `packages/ggcoder/src/core/budget-guard.ts`:
  `BudgetGuard` (state and thresholds), the day ledger
  `~/.israelcode/budget-ledger.json` (`{version:1, days:{YYYY-MM-DD:{projectKey:tokens}}}`,
  pruned to 14 days, written under the shared file lock because several
  windows of one project spend at once) and `RunawayDetector`. The session
  gains an additive `getLoopBreakStats()` (signals plus nudges this run);
  the existing `hook {kind:"loop_break"}` event is the nudge signal.
- **Children count.** `subagent_state.token_usage` is cumulative per child, so
  the controller adds only each snapshot's growth. A parent's turn and its
  children's turns all land on the same session and day totals.
- **Runaway = nudging has failed.** The loop-breaker keeps its two nudges. The
  detector stops the run when a run has seen 3 nudges, or 8 failed tool calls
  in a row, or the same no-progress call 6 times — thresholds well past the
  nudge limits (3/3), so a run is only stopped after it has been steered and
  ignored the steering. The hard stop is on by default and can be switched off
  per project.
- **Stops use the Stop button's path.** The sidecar controller
  (`app-sidecar/budget.ts`) calls `runLifecycle.cancel(...)`, so `run_end`,
  the run journal and the cancel drain behave exactly as a user Stop; it stops
  at most once per kind per run (`noteRunStart`).
- **Persistence** in `~/.israelcode/gg-app.json`: `budgets` keyed per project
  (`{sessionTokens?, dayTokens?, hardStopOnRunaway?}`), validated on load,
  default entry removed on save (`loadBudgetPref`/`saveBudgetPref`).
- **Three app layers, as always.** Routes `GET /budget`, `POST /budget`,
  `POST /budget/continue` (`app-sidecar/budget-routes.ts`, 404 outside coding
  sessions); `budget` in `/state` and the ready frame; events `budget_state`,
  `budget_warning {level, scope, cap, used}`, `budget_exceeded {status}`,
  `runaway_stopped {reasons}`. Rust `agent_get_budget`, `agent_set_budget`,
  `agent_budget_continue` (`commands/budget.rs`); wrappers `getBudget`,
  `setBudget`, `budgetContinue` and `AgentState.budget` in `gg-app/src/agent.ts`.
- **UI.** A title-bar pill (`BudgetMeter.tsx`) shows `used / cap tokens` only
  while a cap is set, grey → amber → red, with today's figure in the tooltip.
  Its popover sets both caps (200k / 1M / 5M / none, or a number), the runaway
  switch and, once stopped, Continue anyway. Warnings are toasts; stops are
  plain-words rows in the chat.

## Consequences

- A stopped run looks like a user Stop to the rest of the app; the chat row
  says why. The user raises the cap or continues; nothing is retried on its own.
- A day cap is advisory across processes: the ledger is read at session start
  and updated per turn, so two windows can each overshoot by one turn.
- Cache-read tokens are not counted (they are not what a cap is meant to
  protect against, and providers price them very differently).
- With no cap set the pill is absent and nothing changes for the user except
  the runaway stop, which only acts on runs the loop-breaker already failed to
  rescue.

## Out of scope

- Budgets in money or an org-wide limit: there is no authoritative pricing and
  no shared backend.
- Per-model or per-role caps; a Goal window's critters (Goals has its own
  controls, and the routes return 404 there).
