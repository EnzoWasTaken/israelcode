# Spec template

One file, the spec, written once by the lead (outside the user repo, e.g. ~/.israelcode/scratch/<project>-SPEC.md). Every worker reads sections 0–2
and its own piece, so those shared sections should stay under about 120 lines.
Numbers beat adjectives. Leave out anything a competent engineer would do
anyway; put in everything a newcomer to this project would otherwise guess.

```markdown
# <Project> — spec
Root: <absolute path> · Run: <command or URL>

## 0. What this is
<2–4 sentences: what it is, who it is for, what "great" means here.>

## 1. Acceptance criteria
Checkable statements taken from the request. The integrator walks this list.
- [ ] <e.g. plays start to finish in 30–60 s; Play and Replay work>
- [ ] <e.g. no console errors; usable at 390 px and 1920 px wide>

## 2. Shared contract
Files and owners:
| File | Piece | Purpose |
|---|---|---|
Interfaces: <exported names, exact signatures with defaults, data shapes,
element ids, events — everything one piece calls or reads from another>
Constants: <sizes, timings, colours with hex values, ports>
Rules for all code: <language and module style, allowed libraries,
determinism, performance budget>
State hook: <how to reach any state directly: ?level=3, ?t=12.5, --seed 7>

## 3. Piece A — <name>   (owner files: …)
What it does: <behaviour, in order of importance>
Target: <for visual or subjective work: proportions, numbers, what good looks
like, and the known-bad looks to avoid>
Hard parts: <the algorithm or approach you want; paste the function if it is
short and decisive>
Check: <the one cheap command that proves it loads and runs>

## 4. Piece B — <name>   (owner files: …)
…

## N. Integration notes
<load order, how the pieces meet, what the integrator should look at first,
which states to screenshot>
```

## Sanity pass before dispatching

Your spec will have bugs. Finding one here costs an edit; finding it after the
build wave costs a fix round.

- Does every file have exactly one owner, and every acceptance criterion a
  piece responsible for it?
- Does every call across a piece boundary appear in section 2 with the same
  name and signature on both sides?
- Do the numbers add up: timings, sizes, anything derived from something else?
  Write the derivation so two workers don't derive it differently.
- Does any rule contradict another (a "silent" moment under a looping sound
  bed; something "hidden until the reveal" that is placed in view earlier)?
- Is each piece inside the builder budget? Split a piece that is too large;
  merge two that are small and share an interface.
- Can the integrator reach every state through the state hook?
