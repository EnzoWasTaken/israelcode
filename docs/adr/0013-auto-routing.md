# ADR 0013: Auto routing

**Status:** Accepted, 2026-11-07.

## Context

Users pick a model and reasoning level by hand; most prompts do not need the
strongest (and slowest, dearest) one. Auto routing picks, per prompt: model,
effort and execution mode (standard, Ultracode, Orchestrate). It is off by
default and never blocks a prompt.

## Architecture and separation

| Layer             | Where                                                                                                                                                   | Responsibility                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine            | `ggcoder/src/core/routing/` (`router`, `signals`, `constraints`, `fallback`, `escalation`, `cache`, `capabilities`, `config`, `explain`, `diagnostics`) | Pure and UI-free: signals → constraints → decision → validation → deterministic fallback. No I/O, no auth, no `fetch` except through an adapter.                                      |
| Decision adapters | `decision-adapter.ts`, `llm-adapter.ts`, `decisions-api-adapter.ts`                                                                                     | Turn a `DecisionInput` into a `RawRouteChoice`. They throw `DecisionError(reason)` and swallow provider error text.                                                                   |
| Runtime           | `app-sidecar/routing-runtime.ts`, `routing-routes.ts`                                                                                                   | Daemon-wide: config + persistence, credentials (masked), registry from real availability, adapter construction, cache, diagnostics, `/routing/*` routes.                              |
| Session hook      | `app-sidecar/session-routing.ts`, called from `prompt-routes.ts` (`runPromptWithRouting`) and `run-control-routes.ts` (manual picks)                    | Per-window: builds the `RouteRequest`, applies the decision for one run, escalates, restores user settings.                                                                           |
| Rust proxy        | `gg-app/src-tauri/src/commands/routing.rs`                                                                                                              | `routing_config_get/set`, `routing_credential_set/clear`, `routing_test`, `routing_diagnostics`, `agent_routing_session`; attaches the session. Preserves unknown `gg-app.json` keys. |
| UI                | `gg-app/src/ModelRouting.tsx` (model picker), `RouteControl.tsx` (per-chat control), `SettingsAutoRouting.tsx` (Settings)                               | Display and input only; reaches the engine solely through `agent.ts` → Tauri → HTTP.                                                                                                  |

The engine does not know about sessions, auth or the webview; the runtime does
not know routing rules; the UI knows neither.

## Decision flow per prompt

1. `runPromptWithRouting` (`session-routing.ts`) runs for a **user** prompt in a
   Code window without a Goal. Scheduled and plan-revision prompts are not
   routed. Mid-run **queued** prompts never reach it (see Scope).
2. `buildRouteRequest` collects: text, attachment kinds, workspace, Goal flag,
   `spawn_agent` availability, recent user texts (300 chars each), context
   tokens, current model/effort/mode and the pins.
3. `routeTask` (`router.ts`):
   1. Feature off → current configuration (`disabled`).
   2. All three dimensions pinned → pins, still checked for warnings.
   3. Hard constraints (`resolveConstraints`): available, not paid, within
      `maxCostTier`, on the allow-list, vision/video if attached, enough
      context. No candidate → current model, `constraint_violation`.
   4. Cache lookup (and follow-up reuse of the session's last decision).
   5. Decision adapter with a timeout (default 4 s); the answer is validated
      (model in candidates, mode allowed, effort clamped to the model and
      `maxEffort`). Any failure or confidence below `confidenceThreshold` →
      deterministic rules.
   6. Pins override per dimension; a short content-free explanation is attached.
4. `applyDecision` switches model / effort / Ultracode / Orchestrate for this
   run and broadcasts `route_decision` **before** the run starts; a
   `route_decision` app marker is persisted. A thrown error runs the prompt on
   the current configuration and shows "Auto routing unavailable — using your
   current model".
5. The prompt is sent, with bounded escalation (below). In `finally`,
   `restoreRunModes` returns Ultracode/Orchestrate to the user's saved setting.

## Capability registry

`buildCapabilityRegistry` over the model registry with real availability (the
same connected-provider logic as `/models`). Each `ModelCapability` has: vision,
video, tools, context window, cost tier, thinking levels, strengths, unitless
relative cost/latency, `available` and `paid`. Family profiles (`FAMILY_PROFILES`)
supply strengths and relative cost/latency; vision/video come from the model
catalog. Local models are excluded. Paid tiers are never available to Auto.
The registry fingerprint is part of the cache key, so connecting or
disconnecting a provider invalidates cached decisions.

## Pin precedence

Per dimension (model / effort / mode), highest first:

1. Session pins (`POST /routing/session`).
2. A manual `/model` pick while Auto is on (sets `pins.model`; also becomes the
   new baseline), a manual thinking change (sets `pins.effort`; turning thinking
   off clears the pin).
3. A typed `ultracode` / `orchestrate` keyword (when that feature is enabled for
   the prompt) and the user's own saved Ultracode/Orchestrate toggles pin
   `executionMode` for the run.
4. The router.

Pins are never overridden; an impossible pin (image to a non-vision model,
unavailable mode) is kept and reported as `pinned_invalid` with a warning. Auto
never calls `persistModelSelection`/`saveProjectModelPrefs`; choices apply to
the run only. The session model stays on the last Auto choice until the next
prompt or a manual pick.

**Auto off** restores the user's baseline: the first manual model/effort before
Auto first changed anything, or the latest explicit pick (`ensureBaseline`,
`adoptBaseline`, `restoreBaseline`). If Auto is turned off mid-run, the restore
is deferred until the run ends (`finishPendingRestore`).

## Scope

Code and chat windows only for the toggle; the engine only offers Ultracode /
Orchestrate in Code windows with `spawn_agent`. Motion windows report
`available: false` with a reason; Goal windows use standard mode only.
Scheduled prompts, plan revisions, autopilot/Ken injected runs and
**queued mid-run prompts are not routed**: in `prompt-routes.ts` a prompt that
arrives while a run (or run claim, or autopilot cycle) is active returns
`queued` before `runPromptWithRouting`, and steers the run already going on its
existing route. Covered by `prompt-routes-queue.test.ts`.

## Cache key and invalidation

`RouteCache` is daemon-wide, a bounded LRU (100) with TTL `cacheTtlMs`
(default 10 min; 0 disables). Only decisions made by a decider (`source:
router`) are stored. The key (`routeCacheKey`) is a hash of: session key,
normalized-text hash, attachment modalities, needs-image/video, pins, config
fingerprint, registry fingerprint, workspace, Goal flag, `spawn_agent`, and the
current provider/model — never raw text. Any config change clears the cache
(`routing-runtime.ts`); registry, pin, model or workspace changes change the
key. Follow-ups ("yes, go ahead") reuse the session's last decision if it is
still a valid candidate and mode.

## Escalation bounds and retry semantics

After a classified provider failure (`classifyEscalation`: rate limit, model
unavailable, provider transient, context overflow; **not** auth, billing,
aborts or bugs), `nextEscalation` may pick another model if:

- escalation is enabled and `attempt <= escalation.maxAttempts` (default 1,
  hard max 2);
- the model was not pinned;
- the run produced **no assistant output or tool calls**
  (`runProducedOutput`); othe
