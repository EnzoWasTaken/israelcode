# Auto routing evaluation

What the offline routing eval shows, and what it does not. Source:
`packages/ggcoder/src/core/routing/routing-eval.test.ts` (fixtures in
`routing-fixtures.ts`). Run it with:

```
cd packages/ggcoder && npx vitest run src/core/routing
```

## Result

`routing-eval.test.ts`: 35 of 35 tests pass (15 representative tasks × 2 routers,
plus 5 deterministic-specific tests). The whole `src/core/routing` suite passes
as part of the verification run for this change.

The eval is **offline and synthetic**. It never calls a model: the "scripted
adapter" is a stub that returns a hand-written answer per task, so it checks the
router's _validation and constraint handling_, not the quality of any real
decision model. Nothing here measures real-world accuracy, latency or cost.

## Setup

- Registry: Claude Haiku 5.5, Sonnet 5.5, Opus 5.5 and Gemini 3.1 Flash-Lite
  (real catalog entries). Video tasks use only the video-capable subset
  (Gemini Flash-Lite).
- Default config (`makeConfig()`), Code workspace unless stated, current model
  Sonnet 5.5.
- **Deterministic fallback**: no adapter (`fallbackReason: no_decision_provider`);
  pure rules from `signals.ts` + `fallback.ts`.
- **Scripted adapter**: confidence 0.9, returns the "scripted pick" below; the
  router still validates it against the allowed candidates and modes.
- "Signal difficulty/kind" is what the heuristics in `signals.ts` computed. The
  scripted adapter may report a different difficulty (e.g. "plan a migration" is
  `hard` by signals but scripted as `moderate`); the table shows the final
  decision.

## Results

The test asserts the expected column as a _set of acceptable modes_ and, for
"simple" tasks, standard mode, the lowest supported effort and a cheap model.
Actual values below are the router's output when the suite was run (Flash-Lite only offers `high`, so that is its
lowest rung).

| Task                   | Modality | Signal difficulty / kind | Acceptable modes                 | Deterministic: model · effort · mode  | Scripted: model · effort · mode    |
| ---------------------- | -------- | ------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------- |
| greeting               | text     | trivial / conversation   | standard                         | Haiku 5.5 · low · standard            | Haiku 5.5 · low · standard         |
| regex question         | text     | trivial / coding         | standard                         | Haiku 5.5 · low · standard            | Flash-Lite · high · standard       |
| typo fix               | text     | trivial / coding         | standard                         | Haiku 5.5 · low · standard            | Haiku 5.5 · low · standard         |
| debug with stack trace | text     | moderate / debugging     | standard                         | Sonnet 5.5 · medium · standard (kept) | Sonnet 5.5 · low · standard (kept) |
| big refactor           | text     | hard / coding            | ultracode, orchestrate           | Opus 5.5 · high · **ultracode**       | Opus 5.5 · high · **orchestrate**  |
| plan a migration       | text     | hard / planning          | standard, ultracode, orchestrate | Opus 5.5 · high · standard            | Opus 5.5 · low · standard          |
| screenshot UI bug      | image    | trivial / vision         | standard                         | Haiku 5.5 · low · standard            | Sonnet 5.5 · low · standard        |
| video attachment       | video    | trivial / vision         | standard                         | Flash-Lite · high · standard          | Flash-Lite · high · standard       |
| research compare       | text     | moderate / research      | standard                         | Sonnet 5.5 · medium · standard (kept) | Sonnet 5.5 · low · standard (kept) |
| chat big task          | text     | hard / coding            | standard (Chat workspace)        | Opus 5.5 · high · standard            | Opus 5.5 · high · standard         |
| goal window            | text     | hard / coding            | standard (Goal)                  | Opus 5.5 · high · standard            | Opus 5.5 · high · standard         |
| no `spawn_agent` tool  | text     | hard / coding            | standard                         | Opus 5.5 · high · standard            | Opus 5.5 · high · standard         |
| decomposable but small | text     | trivial / coding         | standard                         | Haiku 5.5 · low · standard            | Haiku 5.5 · low · standard         |
| short follow-up        | text     | trivial / conversation   | standard                         | Haiku 5.5 · low · standard            | Sonnet 5.5 · low · standard (kept) |
| explain a function     | text     | trivial / coding         | standard                         | Haiku 5.5 · low · standard            | Haiku 5.5 · low · standard         |

## Where orchestration / Ultracode is deliberately not chosen

- **Chat workspace, Goal window, and sessions without `spawn_agent`**: only
  `standard` is allowed (`allowedExecutionModes`), so a hard refactor still gets
  the strongest model but never Ultracode/Orchestrate. In the scripted run the
  decider asks for `orchestrate`; the router substitutes `standard`.
- **Small decomposable tasks** ("rename foo to bar in utils.ts"): standard mode
  on a cheap model — a multi-step mode would cost more than the task.
- **Planning** ("plan a migration"): modes are allowed, but neither router picks
  them; the work is design, not parallel file edits. Strongest model, standard
  mode.
- **Conversation, quick questions, debugging, research, follow-ups**: always
  standard.
- Ultracode/Orchestrate are picked only for the multi-file "big refactor", and
  the deterministic router picks Ultracode while the scripted decider picks
  Orchestrate — both are accepted by the test.

## Behaviour changes (review fixes)

- **Switch-cost rule**: the fixtures above use small contexts (< 8k tokens), so
  their expected routes are unchanged. With a larger mid-conversation context the
  router now keeps the current model (`kept_current`) unless it is under-powered
  for the difficulty or a confident (≥ 0.9) decision has a real quality gap;
  covered in `router.test.ts` ("switch-cost rule").
- **Short follow-up**: only affirmations/continue-words count; "refactor auth" is
  now routed normally. No fixture changed.
- **No vision-capable model**: the decision is the current model with reason
  `no_capable_model` and the explanation "No connected model can read images —
  connect one in Settings" (plus ", and your current model can't either" when it
  can't read images).

## Vision and video cases

- The **screenshot** case requires a vision-capable model. The deterministic
  router picks Haiku 5.5 and the scripted decider Sonnet 5.5; the test asserts
  `vision: true` on whatever was chosen. Candidates without vision are removed
  before any decider sees them (`resolveConstraints`), so a decider cannot pick
  one.
- The **video** case runs against a registry filtered to video-capable models
  (only Gemini Flash-Lite), and asserts `video: true`.
- `an image task with no vision model` yields `fallbackReason:
constraint_violation` and keeps the current model with an explanation, rather
  than sending the image to a model that cannot read it.

## Limits

- Fixed registry and prompts; 15 tasks is a smoke eval, not a benchmark.
- The scripted adapter is an oracle written by the same author as the
  expectations. It proves wiring and validation, not decision quality.
- A real decider (Jev, Luna Decisions, or an LLM) has not been scored here. See
  "Verified vs not verified" in `docs/adr/0013-auto-routing.md`.
