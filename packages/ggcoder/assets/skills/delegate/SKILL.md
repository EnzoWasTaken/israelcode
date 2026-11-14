---
name: delegate
description: "Use when Orchestrate mode is on or the user asks to delegate work to sub-agents. Do NOT use for small jobs."
# Loaded by name from Orchestrate mode's notice; hidden from routine skill selection.
hidden: true
---

# Delegate: the lead's tokens buy judgment, the workers' tokens buy volume

The goal is the result a solo run would have produced, at similar quality, for clearly less money. It is not a way to build or check more than solo would. Earlier team runs cost as much as solo or more because the team did three to six times the work. Everything below stops that.

## Where the money goes

Every request an agent makes re-sends its whole context, so an agent costs roughly **steps × context size**, and a long-running agent's cost grows with the square of its length.

1. **Savings come from the lead not writing code and not reading files or tool output.** Those are the expensive tokens.
2. **Replay is only modestly cheaper on the worker.** If the team replays much more than a solo run would, delegation loses money. The team must do about the same work as solo, not more.
3. **The lead's own steps are the most expensive in the system.** A lead that makes 150 requests and reads the code has spent most of a solo run.

Measured failures: workers building their own preview pages and private test loops, then a QA agent re-testing, then the lead re-testing (4-9x the tool calls); workers living 50-160 steps and being resumed again and again; a lead with a long brief per worker, a ledger, and every file read into its context.

## The budget

Scale with the job. Before adding any agent or step, ask whether a solo run would have done that work. If not, cut it.

| | Budget |
|---|---|
| Lead | about 25 requests; one spec; dispatch prompts of ~8 lines; no source files read after planning; a handful of images |
| Workers | as few as the job splits into cleanly, usually 2-5 builders and 1 integrator |
| Builder | 800-2,500 lines of output, about 30 steps |
| Integrator | about 45 steps |
| Fix rounds | 2 at most, each by a fresh worker |

A step is one message, however many tool calls it carries. Batching independent calls into one message is the cheapest optimisation there is.

## When not to delegate

A worker carries 30-50k tokens of overhead before it does anything, and you pay to brief it and read its report. If you could finish in a dozen tool calls or a couple of hundred lines, do it yourself. Do one-line fixes you have already pinned down yourself too, and anything touching a secret the user gave you.

## The team

Workers are children started with `spawn_agent` and awaited with `wait_agent`. They run on the session's **Worker model**, a user setting; you cannot pick another model per child. If the user names a different worker model in chat, say it differs from the Worker setting and that they can change the setting; do not pretend.

Pick the agent type `spawn_agent` lists: the editing one for builders, integrator and fixers; a read-only one for mapping and review readers. A child with no type or the lead's model is a second lead at lead prices, so avoid it.

## The flow

### 1. Plan (1-3 requests)

Read the request and only as much of the project as needed to split the work. In an existing codebase a few targeted searches beat reading files; if planning needs more than about five files, send one read-only worker to map the area and return 40 lines or fewer.

Split into pieces with **disjoint files**, each sized to the builder budget. Prefer few substantial pieces over many small ones: each worker pays the overhead again and adds a seam that can fail at integration.

### 2. Write the spec (one file, one request)

Write it to a scratch path outside the user's repo (e.g. `~/.israelcode/scratch/<project>-SPEC.md`) and never commit it. Template: `references/spec-template.md`.

The spec is where your judgment enters the build, so spend your output here. A worker starts with none of your context and guesses at anything left open. Decide the hard things yourself: architecture, the tricky algorithm, visual direction in numbers. If a piece hinges on one hard function, write it in the spec. For visual work, copy targets and known-bad looks from `references/review-rubric.md`; preventing a bad look costs a sentence, fixing it costs a round.

Two things make the rest possible:

- **Contracts.** Exact paths, exported names and signatures, data shapes, ids, events, shared constants. With these pinned, dependent pieces can be built at the same time.
- **A way to reach any state directly**, built in: a URL parameter, a CLI flag, a seed. That hook is the only test harness anyone needs.

### 3. Build wave (one message, all builders in parallel)

One `spawn_agent` call per builder, all in the same message, each with this prompt:

```
You are building <piece> of <project>. Project root: <path>.
Read <spec path> sections 0-2 and section <n> (yours). Read nothing else unless the spec points to it.
You own: <files>. Touch no other file.
Check before finishing: <one cheap command: syntax check, unit tests, build>.
Budget: about <N> steps. No preview pages, harnesses, docs or screenshots; integration testing happens after all pieces land.
Report in 8 lines or fewer: files written, check result, deviations from the spec.
```

The spec carries the detail, so the prompt stays short; a long brief per worker was a big share of lead cost.

If parallel builders edit the same checkout, `isolation: "worktree"` is available. Then review each worktree's diff before merging it, and keep file ownership disjoint anyway so merges stay trivial.

Use a second wave only when a piece cannot be written sensibly without another piece's finished code. Two waves at most.

While the wave runs, `wait_agent` and wait. A finished worker while others still run gets a one-line acknowledgement, not a review.

### 4. Integrate and test (one worker)

Verification happens once, on the assembled product, as a solo run would. One fresh worker owns the whole tree:

```
All pieces of <project> are written (spec <path>, root <path>). You now own every file.
Run it the way a user would and walk the acceptance criteria in spec section 1.
Fix what is broken or below the spec's targets, at the source, in whichever file it lives.
Save up to 4 screenshots of the key states to a scratch folder at 1280 px wide or less.
Budget: about 45 steps. Stop there and report what is left rather than pushing on.
Report in 15 lines or fewer: pass/fail per criterion, what you fixed, what remains, how to run it.
```

### 5. Review once (lead)

Read the report and the evidence in one batched step: saved screenshots together, or the test output. For a code change read the diff, not the files. Judge against the spec's criteria and targets.

Then deliver, or write one fix list of up to five defects (where, what is wrong, what correct looks like), grouped by file so fixers own disjoint files, and start **fresh** workers:

```
Fix round on <project> (spec <path>, root <path>). You own: <files>.
1. <where> - <what is wrong> - <what correct looks like>
Check: <command>. Budget: about 25 steps. Report in 8 lines or fewer.
```

After the second fix round, deliver with remaining weaknesses stated plainly. A third round rarely pays for itself.

### 6. Deliver

Tell the user what works and the evidence, known weaknesses, how to run it, and one line on the team: how many workers, on which Worker model.

## Rules that protect the budget

- **Never send a follow-up to a finished child.** A resumed worker re-reads its whole history each step, and idle history is billed again as new context. A fresh worker with a five-line pointer to the spec and the file starts at a tenth of the size.
- **Workers hand over rather than grow.** The step budgets keep contexts small; a step at 400k tokens costs about eight times a step at 50k.
- **A cut-off worker is not a failure.** Its files are on disk. Start a fresh worker with what remains.
- **Keep worker output out of your context.** Short reports; anything long goes in a file you read only if needed.
- **No ledger, no per-worker brief files, no extra design docs.** The spec's ownership table and the reports already in context are the state. After an interruption, read the spec and list the files.
- **One editor per file at a time.** Builders own disjoint files; the integrator owns everything only after builders finish.
- **The integrator starts any server it needs** with the background bash tools, and reports the URL and restart command. Builders start none.
- **Same defect in two places means it lives upstream.** Fix the shared module or spec once.
- **Status to the user:** one line per step. Never report a result before the worker's completion arrives.

## Other shapes of job

**Bug fix or feature in an existing codebase.** Plan with searches, write a short spec (what to change, where, how to verify), send one worker to change it and run the tests, then read the diff. Split only when the change spans areas that share no files.

**Code review, audit or research.** One spec (scope, what counts as a finding, output format, areas), parallel read-only readers each owning a disjoint area of about 3,000 lines and writing findings with file, line and evidence to scratch files, each finding checked by its reader first. Then read the findings and verify the ones you will stake the report on. A separate verifier per reader doubles the bill.

## Reference files

- `references/spec-template.md`: the spec skeleton and a sanity pass before dispatching.
- `references/review-rubric.md`: acceptance checks, numeric targets and known-bad looks; read it when writing the spec for visual or interactive work, and again at review.
