import fs from "node:fs/promises";
import path from "node:path";
import { detectLanguages } from "./language-detector.js";
import { detectVerifyCommands } from "./verify-commands.js";

/**
 * The verify loop: after a turn that changed code, Israel Code runs the
 * project's checks itself (test / typecheck / lint) and, when one fails,
 * hands only the failing output back to the agent as a hidden fix round —
 * up to a cap. This module is the pure engine: config on disk, the fix
 * message and the orchestration. Running commands and prompting the agent
 * are injected, so everything here is testable without a shell or a model.
 */

/** A check to run, as stored in `.gg/verify.json`. */
export interface VerifyCommandSpec {
  label: string;
  command: string;
}

export interface VerifyConfig {
  commands: VerifyCommandSpec[];
  /** Check rounds in one loop: round 1 is the first check; each failing round
   *  short of the last is followed by a fix round. 1 = check and report only. */
  maxRounds: number;
  /** Where the commands came from: the project's file or manifest detection. */
  source: "file" | "detected";
}

export const VERIFY_CONFIG_FILE = path.join(".gg", "verify.json");
export const DEFAULT_VERIFY_MAX_ROUNDS = 3;
export const MAX_VERIFY_ROUNDS = 10;
export const MAX_VERIFY_COMMANDS = 12;
const COMMAND_MAX_CHARS = 2_000;
/** Detected labels we run on the agent's behalf, in this order. */
const DETECTED_LABELS = ["test", "typecheck", "lint"] as const;

interface VerifyConfigFile {
  version: 1;
  commands: VerifyCommandSpec[];
  maxRounds?: number;
}

/** A well-formed command list, or null when the input is not one. */
export function normalizeVerifyCommands(value: unknown): VerifyCommandSpec[] | null {
  if (!Array.isArray(value)) return null;
  const out: VerifyCommandSpec[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { label, command } = item as { label?: unknown; command?: unknown };
    if (typeof label !== "string" || typeof command !== "string") return null;
    const cleanLabel = label.trim();
    const cleanCommand = command.trim();
    if (!cleanLabel || !cleanCommand || cleanCommand.length > COMMAND_MAX_CHARS) return null;
    if (seen.has(cleanCommand)) continue;
    seen.add(cleanCommand);
    out.push({ label: cleanLabel, command: cleanCommand });
    if (out.length > MAX_VERIFY_COMMANDS) return null;
  }
  return out;
}

/** A whole number of rounds within the cap, or undefined when `value` isn't one. */
export function normalizeMaxRounds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.min(MAX_VERIFY_ROUNDS, Math.floor(value));
}

/** Commands the project's manifests promise exist: test, typecheck, lint — one each. */
export function detectVerifyLoopCommands(cwd: string): VerifyCommandSpec[] {
  const detected = detectVerifyCommands(cwd, detectLanguages(cwd));
  const out: VerifyCommandSpec[] = [];
  const seen = new Set<string>();
  for (const label of DETECTED_LABELS) {
    const hit = detected.find((c) => c.label === label && !seen.has(c.command));
    if (!hit) continue;
    seen.add(hit.command);
    out.push({ label: hit.label, command: hit.command });
  }
  return out;
}

/**
 * The project's verify config: `.gg/verify.json` when it is well-formed, else
 * what the manifests say. A file with an empty list means "run nothing".
 */
export async function loadVerifyConfig(cwd: string): Promise<VerifyConfig> {
  const raw = await fs
    .readFile(path.join(cwd, VERIFY_CONFIG_FILE), "utf-8")
    .catch((): null => null);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<VerifyConfigFile> | null;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        const commands = normalizeVerifyCommands(parsed.commands);
        if (commands) {
          return {
            commands,
            maxRounds: normalizeMaxRounds(parsed.maxRounds) ?? DEFAULT_VERIFY_MAX_ROUNDS,
            source: "file",
          };
        }
      }
    } catch {
      // Malformed file: fall through to detection, like no file at all.
    }
  }
  return {
    commands: detectVerifyLoopCommands(cwd),
    maxRounds: DEFAULT_VERIFY_MAX_ROUNDS,
    source: "detected",
  };
}

/** Write `.gg/verify.json` (shared through git) and return the resulting config. */
export async function saveVerifyConfig(
  cwd: string,
  cfg: { commands: VerifyCommandSpec[]; maxRounds?: number },
): Promise<VerifyConfig> {
  const commands = normalizeVerifyCommands(cfg.commands);
  if (!commands) throw new Error("verify commands must each have a label and a command");
  const maxRounds = normalizeMaxRounds(cfg.maxRounds) ?? DEFAULT_VERIFY_MAX_ROUNDS;
  const file: VerifyConfigFile = { version: 1, commands, maxRounds };
  const target = path.join(cwd, VERIFY_CONFIG_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(file, null, 2) + "\n", "utf-8");
  return { commands, maxRounds, source: "file" };
}

export interface VerifyFailure {
  label: string;
  command: string;
  exitCode: number | null;
  tail: string;
}

/** The hidden fix-round prompt: only the failing output, and what to do with it. */
export function buildVerifyFixMessage(
  round: number,
  maxRounds: number,
  failures: readonly VerifyFailure[],
): string {
  const blocks = failures.map((f) => {
    const exit = f.exitCode === null ? "no exit code" : `exit ${f.exitCode}`;
    const output = f.tail.trim() ? f.tail.trim() : "(no output)";
    return `${f.label} (\`${f.command}\`, ${exit}):\n${output}`;
  });
  return (
    `Verify round ${round}/${maxRounds}: these checks failed after your changes — ` +
    `${blocks.join("\n\n")}\n\n` +
    "Fix the cause (not the test, unless the test itself is wrong), re-run the failing check, then stop."
  );
}

export interface VerifyCommandResult {
  label: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  tail: string;
}

export interface VerifyRound {
  round: number;
  results: VerifyCommandResult[];
}

export type VerifyStopReason = "passed" | "max-rounds" | "cancelled" | "no-commands";

export interface VerifyLoopResult {
  passed: boolean;
  rounds: VerifyRound[];
  stoppedReason: VerifyStopReason;
}

/** What the window gets per command (`verify_progress`). */
export interface VerifyProgress {
  round: number;
  maxRounds: number;
  label: string;
  command: string;
  status: "running" | "pass" | "fail";
  exitCode?: number | null;
  durationMs?: number;
  tail?: string;
}

export interface RunCommandOutcome {
  exitCode: number | null;
  durationMs: number;
  tail: string;
  cancelled: boolean;
}

export interface RunVerifyLoopOptions {
  commands: readonly VerifyCommandSpec[];
  maxRounds: number;
  runCommand: (command: VerifyCommandSpec, signal: AbortSignal) => Promise<RunCommandOutcome>;
  /** The hidden fix round; `message` is `buildVerifyFixMessage(...)`. */
  fixRound: (failures: VerifyFailure[], message: string, round: number) => Promise<void>;
  onProgress?: (progress: VerifyProgress) => void;
  signal: AbortSignal;
}

/**
 * Run every command in order, round by round. All pass → done. Any fail →
 * one fix round, then check again, until the cap. Stop (the signal) ends the
 * loop at the next boundary; a cancelled command ends it at once.
 */
export async function runVerifyLoop(opts: RunVerifyLoopOptions): Promise<VerifyLoopResult> {
  const maxRounds = normalizeMaxRounds(opts.maxRounds) ?? DEFAULT_VERIFY_MAX_ROUNDS;
  const rounds: VerifyRound[] = [];
  if (opts.commands.length === 0) return { passed: true, rounds, stoppedReason: "no-commands" };

  for (let round = 1; round <= maxRounds; round++) {
    const results: VerifyCommandResult[] = [];
    rounds.push({ round, results });
    const failures: VerifyFailure[] = [];
    for (const command of opts.commands) {
      if (opts.signal.aborted) return { passed: false, rounds, stoppedReason: "cancelled" };
      opts.onProgress?.({ round, maxRounds, ...command, status: "running" });
      const outcome = await opts.runCommand(command, opts.signal);
      const result: VerifyCommandResult = {
        ...command,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        tail: outcome.tail,
      };
      results.push(result);
      if (outcome.cancelled || opts.signal.aborted) {
        return { passed: false, rounds, stoppedReason: "cancelled" };
      }
      const passed = outcome.exitCode === 0;
      opts.onProgress?.({
        round,
        maxRounds,
        ...command,
        status: passed ? "pass" : "fail",
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        tail: outcome.tail,
      });
      if (!passed) failures.push(result);
    }
    if (failures.length === 0) return { passed: true, rounds, stoppedReason: "passed" };
    if (round === maxRounds) break;
    try {
      await opts.fixRound(failures, buildVerifyFixMessage(round, maxRounds, failures), round);
    } catch (err) {
      if (opts.signal.aborted) return { passed: false, rounds, stoppedReason: "cancelled" };
      throw err;
    }
    if (opts.signal.aborted) return { passed: false, rounds, stoppedReason: "cancelled" };
  }
  return { passed: false, rounds, stoppedReason: "max-rounds" };
}

/** Tools whose calls mean the turn changed files on disk. */
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "notebook_edit", "apply_patch"]);

/** Did this turn's tool calls write or edit files? (Shell commands don't count.) */
export function turnWroteFiles(toolCalls: ReadonlyArray<{ name: string }>): boolean {
  return toolCalls.some((call) => WRITE_TOOLS.has(call.name));
}
