# ADR 0013: Auto routing

**Status:** Accepted, 2026-11-07.

## Context

Users pick a model and reasoning level by hand; most prompts do not need the
strongest (and slowest, dearest) one. Auto routing picks per prompt: model,
effort and execution mode (standard, Ultracode, Orchestrate). The engine lives
in `ggcoder/src/core/routing/` (pure, tested); this ADR covers how it is wired
into the sidecar, Rust shell and webview API.

## Decision

### Decision models

`config.decider` is one of:

- `model` — a connected low/medium-cost chat model called with one stateless
  tool-call (`createLlmDecisionAdapter`). Only models whose provider is connected
  with a **static API key** are offered. Sign-in (OAuth) connections
  (Anthropic, OpenAI, Gemini, Kimi OAuth) are listed as _unavailable_ with a
  note: a stateless side call there needs provider-specific transports/headers
  that we have not verified, so we do not guess.
- `decisions-api` — the Decisions API, one request returning choice/score
  answers:
  - OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`, OpenRouter key,
    model `typesafe/jev-1.14`; `openai/gpt-6-luna-decisions` uses the same API.
  - TypeSafe direct: `POST https://api.typesafe.ai/v1/systemone`, TypeSafe key,
    model `jev-latest`.
  - Both use `Authorization: Bearer`. Encoded in `DECISION_SERVICE_DEFAULTS`.

**Not verified live:** no call to either service was made while building this
(no keys in the build environment). Request/response shapes are from the
documented contract and the adapter tests with mocked `fetch`; the Settings
"Test" button (`POST /routing/test`) is how a user verifies them. Likewise the
real `session.prompt` failure shape that drives escalation is unverified live.

### Registry, validation, fallback, confidence

`buildCapabilityRegistry` over the model registry with real availability (the
same connected-provider logic as `/models`, local models excluded, paid tiers
never). The router validates every answer (model in candidates, mode allowed,
effort clamped to what the model supports and `maxEffort`), and below
`confidenceThreshold` or on any error/timeout it uses deterministic rules and
reports a `fallbackReason`. Images/video are never routed to non-capable models.
Routing never blocks a prompt: a thrown error runs the prompt on the current
configuration and shows "Auto routing unavailable — using your current model".

### Pins and precedence

Per dimension, highest first: session pins (`POST /routing/session`), a manual
`/model` pick while Auto is on (sets `pins.model`), a manual thinking change
(sets `pins.effort`; turning thinking off clears the pin), the typed
`ultracode`/`orchestrate` keyword and the user's own Ultracode/Orchestrate
toggles (pin `executionMode` for the run), then the router. Auto never calls
`persistModelSelection`/`saveProjectModelPrefs`; the chosen model, effort, and
mode apply to the run, and Ultracode/Orchestrate go back to the user's saved
setting afterwards. The session model stays on the last Auto choice until the
next prompt or a manual pick.

### Scope

Code and chat windows only. Motion and Goal windows report
`available: false` with a reason. Only user prompts route; scheduled prompts,
plan revisions, queued (mid-run steering) prompts and autopilot/Ken injected
runs do not.

### Caching

`RouteCache` is daemon-wide (keyed by hashes of request shape, config and
registry; never raw text), TTL `cacheTtlMs`, cleared when the config changes.
Follow-ups reuse the session's last decision.

### Escalation bounds and cost controls

After a classified provider failure (rate limit, model unavailable, provider
transient, context overflow; not auth/billing) and only if the run produced **no
assistant output or tool calls**, `nextEscalation` picks an alternative
(bounded by `escalation.maxAttempts`, default 1, max 2; never replaces a pinned
model). The prompt is retried via a hidden runtime note (the user message is
already in the transcript) — no duplicate tool calls by construction. Costs:
paid tiers are never chosen, `maxCostTier`/`maxEffort` cap choices, the decision
call is a single short request with a timeout (default 4 s, test 10 s) and
decisions are cached.

### Diagnostics

Every decision is logged as `toDiagnostic` output only: hashes and lengths, no
task text, no secrets. In-memory ring of 50 plus
`<agentDir>/routing-diagnostics.jsonl` trimmed to ~500 lines
(`GET /routing/diagnostics`). The transcript keeps a `route_decision` app marker
(content-free summary) so a restored session can show it.

### Credentials

OpenRouter uses the existing `openrouter` provider entry in `auth.json` — one
credential; `POST /routing/credential` refuses to overwrite it unless
`replace: true`. The TypeSafe key is stored under `typesafe` through
`AuthStorage` (file mode 0600) and is **not** in the AI provider list.
Responses carry only `••••` + last four characters; keys are never logged or
echoed, test errors are plain-language ("The key was rejected (401)").

### Surface

Daemon-level (no session): `GET|POST /routing/config`, `POST /routing/credential`,
`DELETE /routing/credential/typesafe`, `POST /routing/test`,
`GET /routing/diagnostics`. Session-level: `POST /routing/session`, events
`route_state` and `route_decision`, and `autoRoute` in `/state` and the ready
frame. Config is stored as `autoRoute` in `gg-app.json` (missing/invalid → Auto
off); the Rust writer preserves unknown keys.

## Consequences

Existing installs migrate silently with Auto off. OAuth-only users cannot use a
model decider until a safe stateless path is verified; Decisions API options
still work with a key.
