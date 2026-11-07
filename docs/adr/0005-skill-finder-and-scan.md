# ADR 0005: A skill finder that scans before it installs

**Status:** Accepted, 2026-11-06.

## Context

Until now a skill reached Israel Code by hand: the user found it on skills.sh or
GitHub, ran `npx skills add owner/repo` (or copied a folder) and the agent
picked it up on the next session. Nothing looked at the skill first. A skill is
Markdown plus whatever scripts and hooks the author put next to it, and the
agent follows it with the user's tools and the user's files.

That trust was abused in 2025–26. The ToxicSkills research found hundreds of
skills on public indexes carrying prompt injection, hidden exfiltration of keys
and SSH material, and `curl | sh` install steps dressed up as setup. The
ClawHavoc campaign seeded skill-like packages into agent marketplaces, and the
damage was done at install or first load, before the user had read a line.
Audit badges on the indexes help, but they come from third parties, cover only
some skills, and are not shown anywhere in Israel Code.

The CLI already has the pieces for discovery, download and summary of a skill.
The app had no Skills page at all.

## Decision

- **Settings → Skills** (`gg-app/src/SkillsModal.tsx`) is the one place to
  find, read, install and remove skills. It mirrors the MCP page: Global or
  Project scope, same project picker, same voice.
- **Search** goes to the skills.sh API first; when it fails or returns nothing
  useful the sidecar falls back to GitHub search and says so in a `notice` the
  page shows. Results carry name, source repo, installs or stars, origin and
  any audit badges the index already publishes.
- **Inspect before install.** Picking a result downloads the skill to memory
  or a temp folder, summarises it (description, compatibility, license,
  allowed tools, scripts, hooks, shell run at load, file count and size) and
  runs the static scan. **Nothing in the skill is executed** at any point
  before the user installs it, and the install itself only copies files. A
  whole-repo hit returns its candidate skills to choose from.
- **The scan is static rules with severities** (`critical`, `high`, `medium`,
  `low`), each finding naming the rule, file and line, the reason and the
  matching text. The verdict is `pass` (no findings), `warn` (medium/low
  only) or `block` (any critical or high).
- **Block means block.** The Install button is disabled; a secondary "Install
  anyway" opens a confirm step whose default is Cancel and whose words are
  plain: Israel Code will not vouch for the skill. Confirming sends
  `override: true`; the sidecar refuses a block without it, and every
  override is logged and marked on the installed entry
  (`overridden: true`, shown as "Installed despite findings").
- **Where skills land.** Project scope writes to the chosen project's
  `.gg/skills/<name>`; Global writes to `~/.israelcode/skills/<name>`. Each
  scope keeps a `skills-lock.json` with source, slug, content hash, commit,
  install and scan time, verdict and override flag, so the installed list and
  later re-scans do not depend on re-reading the index.
- The three app layers follow the usual pattern: sidecar routes, Rust
  `#[tauri::command]` proxies, typed wrappers in `agent.ts` (`searchSkills`,
  `inspectSkill`, `installSkill`, `listInstalledSkills`,
  `removeInstalledSkill`).

## Consequences

- A skill the scan blocks takes two deliberate clicks and a warning to
  install; that friction is the point, and the log makes an override
  traceable when something later goes wrong.
- Static rules have false positives (a legitimate `curl` to a vendor API reads
  the same as exfiltration) and misses (obfuscated or fetched-at-runtime
  payloads). The page shows the evidence so the user can judge, and the
  verdict is a floor, not a promise of safety.
- Searching and inspecting are network calls to skills.sh and GitHub without a
  token, so they share the unauthenticated rate limits; the fallback and the
  notice exist so a quiet index does not look like an empty one.
- Skills installed by hand (copied folders, `npx skills add`) still work and
  appear in the installed list without a verdict ("Not scanned"); they are not
  removed or re-scanned on the user's behalf.

## Out of scope

- No GitHub or skills.sh token and no settings for one.
- No code search inside skills beyond the scan's rules; no dependency or
  reputation lookups of our own.
- No LLM judge of a skill's intent: the verdict comes from the rules alone so
  it is the same every time and can be read back line by line.
- No automatic updates or re-scans of installed skills.
