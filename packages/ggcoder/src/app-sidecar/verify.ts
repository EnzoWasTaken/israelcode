import { log } from "../core/logger.js";
import {
  runVerifyLoop,
  type RunCommandOutcome,
  type VerifyCommandSpec,
  type VerifyConfig,
  type VerifyFailure,
  type VerifyLoopResult,
  type VerifyProgress,
} from "../core/verify-loop.js";
import { runShellCommandOnce } from "./shell-runs.js";

/** What `/verify`, the ready frame and `verify_state` events carry. */
export interface VerifyStatePayload {
  enabled: boolean;
  config: VerifyConfig;
  running: boolean;
}

export interface VerifyController {
  readonly enabled: boolean;
  readonly config: VerifyConfig;
  readonly running: boolean;
  statePayload(): VerifyStatePayload;
  /** The user's switch (saved by the route) and config (saved to `.gg/verify.json`). */
  setEnabled(enabled: boolean): VerifyStatePayload;
  setConfig(config: VerifyConfig): VerifyStatePayload;
  /**
   * Run the loop now with the current config. Broadcasts `verify_progress`
   * per command and `verify_result` at the end, and persists the result as a
   * `verify` app marker. Null when a loop is already running. Callers wrap
   * this in `runAgent` so the Stop button and run lifecycle apply.
   */
  start(): Promise<VerifyLoopResult | null>;
  /** Stop the running check and the loop (the Stop button's path). */
  cancel(): void;
}

export interface VerifyControllerOptions {
  cwd: string;
  enabled: boolean;
  config: VerifyConfig;
  broadcast: (type: string, data: unknown) => void;
  /** The hidden fix round: prompt the agent with `message` inside the run. */
  fixRound: (message: string, failures: VerifyFailure[], round: number) => Promise<void>;
  /** Persist the result so a reopened window shows it. */
  persistMarker: (data: Record<string, unknown>) => Promise<void>;
  /** Command runner override for tests. */
  runCommand?: (command: VerifyCommandSpec, signal: AbortSignal) => Promise<RunCommandOutcome>;
}

export function createVerifyController(opts: VerifyControllerOptions): VerifyController {
  let enabled = opts.enabled;
  let config = opts.config;
  let active: AbortController | null = null;

  function statePayload(): VerifyStatePayload {
    return { enabled, config, running: active !== null };
  }

  const runCommand =
    opts.runCommand ??
    (async (command: VerifyCommandSpec, signal: AbortSignal): Promise<RunCommandOutcome> => {
      const run = await runShellCommandOnce({ cwd: opts.cwd, command: command.command, signal });
      const tail = run.error
        ? `failed to start: ${run.error}`
        : run.timedOut
          ? `${run.tail}\n(stopped: the check ran past the time limit)`.trim()
          : run.tail;
      return {
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        tail,
        // A timeout is a failed check, not a user stop.
        cancelled: run.cancelled && !run.timedOut,
      };
    });

  const controller: VerifyController = {
    get enabled() {
      return enabled;
    },
    get config() {
      return config;
    },
    get running() {
      return active !== null;
    },
    statePayload,
    setEnabled: (next) => {
      enabled = next;
      const payload = statePayload();
      opts.broadcast("verify_state", payload);
      return payload;
    },
    setConfig: (next) => {
      config = next;
      const payload = statePayload();
      opts.broadcast("verify_state", payload);
      return payload;
    },
    start: async () => {
      if (active) return null;
      const ac = new AbortController();
      active = ac;
      opts.broadcast("verify_state", statePayload());
      log("INFO", "verify", "verify loop starting", {
        commands: String(config.commands.length),
        maxRounds: String(config.maxRounds),
      });
      try {
        const result = await runVerifyLoop({
          commands: config.commands,
          maxRounds: config.maxRounds,
          signal: ac.signal,
          runCommand,
          fixRound: (failures, message, round) => opts.fixRound(message, failures, round),
          onProgress: (progress: VerifyProgress) => opts.broadcast("verify_progress", progress),
        });
        log("INFO", "verify", "verify loop finished", {
          passed: String(result.passed),
          rounds: String(result.rounds.length),
          stoppedReason: result.stoppedReason,
        });
        opts.broadcast("verify_result", result);
        if (result.stoppedReason !== "no-commands") {
          await opts.persistMarker({ ...result }).catch((err: unknown) => {
            log("WARN", "verify", "verify marker not persisted", {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }
        return result;
      } finally {
        active = null;
        opts.broadcast("verify_state", statePayload());
      }
    },
    cancel: () => {
      active?.abort();
    },
  };
  return controller;
}

/** A persisted `verify` marker's data back into a history row; null when it isn't one. */
export function restoreVerifyMarker(d: Record<string, unknown>): VerifyLoopResult | null {
  if (typeof d.passed !== "boolean" || !Array.isArray(d.rounds)) return null;
  const reason = d.stoppedReason;
  if (
    reason !== "passed" &&
    reason !== "max-rounds" &&
    reason !== "cancelled" &&
    reason !== "no-commands"
  ) {
    return null;
  }
  const rounds = d.rounds.flatMap((r): VerifyLoopResult["rounds"] => {
    if (!r || typeof r !== "object") return [];
    const round = r as { round?: unknown; results?: unknown };
    if (typeof round.round !== "number" || !Array.isArray(round.results)) return [];
    return [
      {
        round: round.round,
        results: round.results.flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const res = x as Record<string, unknown>;
          if (typeof res.label !== "string" || typeof res.command !== "string") return [];
          return [
            {
              label: res.label,
              command: res.command,
              exitCode: typeof res.exitCode === "number" ? res.exitCode : null,
              durationMs: typeof res.durationMs === "number" ? res.durationMs : 0,
              tail: typeof res.tail === "string" ? res.tail : "",
            },
          ];
        }),
      },
    ];
  });
  return { passed: d.passed, rounds, stoppedReason: reason };
}
