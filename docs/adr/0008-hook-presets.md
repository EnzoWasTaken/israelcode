# ADR 0008: Hook presets — the five hooks everyone writes, as switches

**Status:** Accepted, 2026-11-06.

## Context

Every coding agent ships shell hooks (Claude Code's `PreToolUse`/`PostToolUse`/
`Stop`, Cursor's and Gemini CLI's equivalents) and none ships presets. So every
user hand-writes the same five scripts: format after an edit, lint after an
edit, keep the agent out of some paths, refuse dangerous commands, say when the
run is done. The scripts are glued on from outside the tool, differ per
machine, and are rarely shared with the repo. Israel Code already had the
pieces: a tool wrapper shape (`wrapWithApproval`), the catastrophic-command
guard (`core/workspace-guard.ts`), the destructive-git parser
(`core/destructive-git-guard.ts`), manifest-based command detection
(`core/verify-commands.ts`) and the user-shell runner (`runShellCommandOnce`).

## Decision

- **Presets are built in; no script.** `formatOnEdit`, `lintOnEdit`,
  `protectPaths`, `blockDangerous`, `notifyOnFinish` are switches. Format and
  lint commands are detected from the project (prettier via deps or rc file,
  eslint, rustfmt, ruff/black, gofmt — file-scoped, lint never `--fix`) and
  can be overridden with a `{file}` placeholder. `blockDangerous` reuses the
  existing guards and adds `rm -r` outside the project and publish/registry
  commands; it blocks destructive git statically, not only when uncommitted
  work exists.
- **Two files, like the verify loop.** The config is
  `<project>/.gg/hooks.json` (`{version:1, presets, custom}`), shared through
  git. The on/off switch is per project in `~/.israelcode/gg-app.json`
  (`hooks: {projectKey: {enabled}}`), off by default: a cloned repo's hooks
  never run until the user turns them on.
- **`custom` keeps power users.** `{id, event: preToolUse|postToolUse|stop,
tool?, command, timeoutMs?}`; exit code 2 blocks the call and its output tail
  is the reason the model sees (Claude Code's convention). Any other failure
  is reported, never fatal.
- **The wrapper sits after `wrapTool` and before approval**
  (`core/hook-wrap.ts`, applied in `AgentSession`). Same names and schemas, so
  the prompt cache is untouched; a call a hook blocks never shows an approval
  card. A blocked call returns `Error: blocked by hook <id>: <reason>` without
  running. Post hooks run serially after the tool (60 s each); only a failing
  hook's last 30 lines are appended (`[lint] exit 1 …`), so a clean format
  costs the model nothing. The wrapper never throws.
- **Notify through the window, not the OS.** On a user-initiated run's end the
  sidecar runs `stop` hooks and broadcasts `hook_notify {title, body}`; the
  webview shows a web `Notification` when it is in the background (WebView2
  supports it; no plugin) and a toast otherwise.
- **Three app layers.** Routes `GET /hooks`, `POST /hooks` (`enabled?`,
  `config?`); `hooks: {enabled}` in `/state` and the ready frame; events
  `hooks_state`, `hook_event {hookId, label, tool, phase, outcome, detail?,
durationMs?}`, `hook_notify`. Rust `agent_get_hooks`/`agent_set_hooks`;
  wrappers `getHooks`/`setHooks`; a Settings → Hooks page (`HooksPanel.tsx`)
  with the switches, overrides, globs, custom hooks and recent activity.
  Blocked and failed hooks also get a one-line notice in the transcript.

## Consequences

- A format hook on every edit adds its run time to each tool call; the
  per-tool ceiling is extended by two minutes to leave room.
- `protectPaths` is a guard on the agent's file tools, not on the shell: a
  `bash` call can still touch a protected file. `blockDangerous` covers the
  shell side for the known-dangerous shapes only.
- A wrong override command fails every edit with the same tail; the Hooks page
  shows it in recent activity, and the model sees the failure once per edit.
- The glob matcher is our own (`**`, `*`, `?`, `{a,b}`, gitignore-style bare
  names), not minimatch; exotic patterns may differ.

## Out of scope

- HTTP or MCP hooks, prompt-rewriting hooks, and hooks on model output: only
  shell commands around `write`/`edit`/`multi_edit`/`notebook_edit`/
  `apply_patch`/`bash` and at run end.
- Subagents' tools: the wrapper is applied to the window's coding
  `AgentSession` only. Children spawned by Orchestrate, Ken and Goals sessions
  run without hooks.
- A `UserPromptSubmit`-style hook and per-hook matchers beyond one tool name.
