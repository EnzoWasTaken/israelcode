import path from "node:path";
import {
  detectFormatCommand,
  detectLintCommand,
  resolveStopHooks,
  type HooksConfig,
} from "../core/hook-presets.js";
import {
  lastLines,
  type HookEvent,
  type HookRunResult,
  type HooksRuntime,
} from "../core/hook-wrap.js";
import { log } from "../core/logger.js";
import { runShellCommandOnce } from "./shell-runs.js";

/** How many hook events a window keeps for `GET /hooks`. */
export const HOOK_EVENTS_KEPT = 50;

/** What `hooks_state` events carry. */
export interface HooksStatePayload {
  enabled: boolean;
  config: HooksConfig;
}

/** What `GET /hooks` and `POST /hooks` return. */
export interface HooksPayload extends HooksStatePayload {
  /** What the presets would run for a typical file here, for the settings UI. */
  detected: { format?: string; lint?: string };
  recent: HookEvent[];
}

/** What `hook_notify` carries: the window shows it as a desktop notification. */
export interface HookNotifyPayload {
  title: string;
  body: string;
}

export interface HooksController {
  readonly enabled: boolean;
  readonly config: HooksConfig;
  statePayload(): HooksStatePayload;
  payload(): HooksPayload;
  /** The user's switch (saved by the route) and config (saved to `.gg/hooks.json`). */
  setEnabled(enabled: boolean): HooksStatePayload;
  setConfig(config: HooksConfig): HooksStatePayload;
  /** For `AgentSession`'s `getHooksRuntime`: undefined while the switch is off. */
  runtime(): HooksRuntime | undefined;
  /** Record and broadcast one event (the wrapper's `onEvent`). */
  record(ev: HookEvent): void;
  recent(): HookEvent[];
  /**
   * A user-initiated run ended: run the `stop` custom hooks, then broadcast
   * `hook_notify` when notifyOnFinish is on. No-op while the switch is off.
   */
  afterUserRun(replyText: string): Promise<void>;
}

export interface HooksControllerOptions {
  cwd: string;
  enabled: boolean;
  config: HooksConfig;
  broadcast: (type: string, data: unknown) => void;
  /** Command runner override for tests. */
  runCommand?: (command: string, timeoutMs: number, signal: AbortSignal) => Promise<HookRunResult>;
}

/** The sample files detection is run against, by project kind. */
const SAMPLE_FILES = ["src/index.ts", "src/index.js", "src/main.rs", "main.py", "main.go"];

export function detectPresetCommands(cwd: string): { format?: string; lint?: string } {
  const out: { format?: string; lint?: string } = {};
  for (const sample of SAMPLE_FILES) {
    if (!out.format) {
      const format = detectFormatCommand(cwd, sample);
      if (format) out.format = format;
    }
    if (!out.lint) {
      const lint = detectLintCommand(cwd, sample);
      if (lint) out.lint = lint;
    }
    if (out.format && out.lint) break;
  }
  return out;
}

/** The first non-empty line of the reply, trimmed to notification size. */
export function notifyBody(project: string, replyText: string): string {
  const line =
    replyText
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const summary = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  return `${project} — done: ${summary || "run finished"}`;
}

export function createHooksController(opts: HooksControllerOptions): HooksController {
  let enabled = opts.enabled;
  let config = opts.config;
  const events: HookEvent[] = [];
  const project = path.basename(opts.cwd) || opts.cwd;

  const runCommand =
    opts.runCommand ??
    (async (command: string, timeoutMs: number, signal: AbortSignal): Promise<HookRunResult> => {
      const run = await runShellCommandOnce({ cwd: opts.cwd, command, timeoutMs, signal });
      const tail = run.error
        ? `failed to start: ${run.error}`
        : run.timedOut
          ? `${run.tail}\n(stopped: the hook ran past its time limit)`.trim()
          : run.tail;
      return { exitCode: run.exitCode, tail };
    });

  function statePayload(): HooksStatePayload {
    return { enabled, config };
  }

  function record(ev: HookEvent): void {
    events.push(ev);
    if (events.length > HOOK_EVENTS_KEPT) events.splice(0, events.length - HOOK_EVENTS_KEPT);
    opts.broadcast("hook_event", ev);
  }

  const runtime: HooksRuntime = {
    get config() {
      return config;
    },
    cwd: opts.cwd,
    runCommand,
    onEvent: record,
  };

  const controller: HooksController = {
    get enabled() {
      return enabled;
    },
    get config() {
      return config;
    },
    statePayload,
    payload: () => ({
      ...statePayload(),
      detected: detectPresetCommands(opts.cwd),
      recent: [...events],
    }),
    setEnabled: (next) => {
      enabled = next;
      const payload = statePayload();
      opts.broadcast("hooks_state", payload);
      return payload;
    },
    setConfig: (next) => {
      config = next;
      const payload = statePayload();
      opts.broadcast("hooks_state", payload);
      return payload;
    },
    runtime: () => (enabled ? runtime : undefined),
    record,
    recent: () => [...events],
    afterUserRun: async (replyText) => {
      if (!enabled) return;
      for (const action of resolveStopHooks(config)) {
        const started = Date.now();
        try {
          const run = await runCommand(
            action.command ?? "",
            action.timeoutMs,
            new AbortController().signal,
          );
          const failed = run.exitCode !== 0;
          record({
            hookId: action.id,
            label: action.label,
            tool: "stop",
            phase: "post",
            outcome: failed ? "failed" : "ran",
            ...(failed ? { detail: lastLines(run.tail).trim() } : {}),
            durationMs: Date.now() - started,
          });
        } catch (err) {
          record({
            hookId: action.id,
            label: action.label,
            tool: "stop",
            phase: "post",
            outcome: "failed",
            detail: `could not run: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - started,
          });
        }
      }
      if (config.presets.notifyOnFinish.enabled) {
        const payload: HookNotifyPayload = {
          title: "Israel Code",
          body: notifyBody(project, replyText),
        };
        opts.broadcast("hook_notify", payload);
        log("INFO", "hooks", "notify on finish", { project });
      }
    },
  };
  return controller;
}
