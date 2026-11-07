import type { AgentTool, ToolContext, ToolExecuteResult } from "@kenkaiiii/gg-agent";
import {
  FILE_MUTATING_TOOLS,
  resolveHooksForTool,
  type HookAction,
  type HooksConfig,
} from "./hook-presets.js";

/** What a hook command produced: exit code and the last lines of its output. */
export interface HookRunResult {
  exitCode: number | null;
  tail: string;
}

/**
 * What the wrapper needs from its host, read on every call so a config
 * change applies to the next tool call. Undefined = hooks off.
 */
export interface HooksRuntime {
  config: HooksConfig;
  cwd: string;
  runCommand(command: string, timeoutMs: number, signal: AbortSignal): Promise<HookRunResult>;
  onEvent(ev: HookEvent): void;
}

export interface HookEvent {
  hookId: string;
  label: string;
  tool: string;
  phase: "pre" | "post";
  outcome: "blocked" | "ran" | "failed" | "skipped";
  detail?: string;
  durationMs?: number;
}

/** A command hook exits 2 to block the call (like Claude Code). */
export const HOOK_BLOCK_EXIT_CODE = 2;
/** Lines of a failing hook's output the model gets to see. */
export const HOOK_TAIL_LINES = 30;
/** Time the loop's per-tool ceiling is extended by for hooks around a call. */
const HOOK_WAIT_MS = 2 * 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

const HOOKED_TOOLS: ReadonlySet<string> = new Set([...FILE_MUTATING_TOOLS, "bash"]);

export function lastLines(text: string, count = HOOK_TAIL_LINES): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function blockedText(action: HookAction): string {
  return `Error: blocked by hook ${action.id}: ${action.reason ?? "the hook refused this call"}`;
}

/** Add `note` to the end of a tool result, whatever its shape. */
export function appendToResult(result: ToolExecuteResult, note: string): ToolExecuteResult {
  if (typeof result === "string") return `${result}${note}`;
  if (typeof result.content === "string") return { ...result, content: `${result.content}${note}` };
  return { ...result, content: [...result.content, { type: "text", text: note.trimStart() }] };
}

async function runAction(
  rt: HooksRuntime,
  action: HookAction,
  tool: string,
  phase: "pre" | "post",
  signal: AbortSignal,
): Promise<{ result: HookRunResult | null; durationMs: number }> {
  const started = Date.now();
  try {
    const result = await rt.runCommand(action.command ?? "", action.timeoutMs, signal);
    return { result, durationMs: Date.now() - started };
  } catch (err) {
    rt.onEvent({
      hookId: action.id,
      label: action.label,
      tool,
      phase,
      outcome: "failed",
      detail: `could not run: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    });
    return { result: null, durationMs: Date.now() - started };
  }
}

/**
 * Wrap a tool so the project's hooks run around it. Pre hooks may block the
 * call (presets: protected paths, dangerous commands; custom: exit code 2),
 * in which case the tool never runs and the model gets an `Error: blocked by
 * hook …` result. Post hooks run serially after the tool; a failing one
 * appends its output tail to the result. A hook failing never breaks the
 * tool, and nothing here throws. Same name, description and schema
 * (cache-stable). Tools no hook covers are returned as they are.
 */
export function wrapWithHooks(
  tool: AgentTool,
  getHooks: () => HooksRuntime | undefined,
): AgentTool {
  if (!HOOKED_TOOLS.has(tool.name)) return tool;
  const ceiling = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return {
    ...tool,
    timeoutMs: Number.isFinite(ceiling) ? ceiling + HOOK_WAIT_MS : ceiling,
    async execute(args: unknown, context: ToolContext) {
      const rt = safeGet(getHooks);
      if (!rt) return tool.execute(args as never, context);
      let hooks: ReturnType<typeof resolveHooksForTool>;
      try {
        hooks = resolveHooksForTool(rt.config, tool.name, args, rt.cwd);
      } catch {
        return tool.execute(args as never, context);
      }
      const emit = (ev: HookEvent): void => {
        try {
          rt.onEvent(ev);
        } catch {
          // The host's listener is not the tool's problem.
        }
      };

      for (const action of hooks.pre) {
        if (action.kind === "block") {
          emit({
            hookId: action.id,
            label: action.label,
            tool: tool.name,
            phase: "pre",
            outcome: "blocked",
            detail: action.reason ?? "",
          });
          return blockedText(action);
        }
        if (context.signal.aborted) break;
        const { result, durationMs } = await runAction(
          rt,
          action,
          tool.name,
          "pre",
          context.signal,
        );
        if (!result) continue;
        if (result.exitCode === HOOK_BLOCK_EXIT_CODE) {
          const reason = lastLines(result.tail).trim() || "the hook refused this call";
          emit({
            hookId: action.id,
            label: action.label,
            tool: tool.name,
            phase: "pre",
            outcome: "blocked",
            detail: reason,
            durationMs,
          });
          return blockedText({ ...action, reason });
        }
        emit({
          hookId: action.id,
          label: action.label,
          tool: tool.name,
          phase: "pre",
          outcome: result.exitCode === 0 ? "ran" : "failed",
          ...(result.exitCode === 0 ? {} : { detail: lastLines(result.tail) }),
          durationMs,
        });
      }

      // The tool's own ceiling applies to the tool itself, as in wrapWithApproval.
      const signal = Number.isFinite(ceiling)
        ? AbortSignal.any([context.signal, AbortSignal.timeout(ceiling)])
        : context.signal;
      let result = await tool.execute(args as never, { ...context, signal });

      if (hooks.post.length === 0 || isErrorResult(result)) return result;
      const notes: string[] = [];
      for (const action of hooks.post) {
        if (action.kind !== "run") continue;
        if (context.signal.aborted) {
          emit({
            hookId: action.id,
            label: action.label,
            tool: tool.name,
            phase: "post",
            outcome: "skipped",
          });
          continue;
        }
        const { result: run, durationMs } = await runAction(
          rt,
          action,
          tool.name,
          "post",
          context.signal,
        );
        if (!run) continue;
        if (run.exitCode === 0) {
          emit({
            hookId: action.id,
            label: action.label,
            tool: tool.name,
            phase: "post",
            outcome: "ran",
            durationMs,
          });
          continue;
        }
        const tail = lastLines(run.tail).trim();
        emit({
          hookId: action.id,
          label: action.label,
          tool: tool.name,
          phase: "post",
          outcome: "failed",
          detail: tail,
          durationMs,
        });
        const exit = run.exitCode === null ? "stopped" : `exit ${run.exitCode}`;
        notes.push(`[${action.label}] ${exit}${tail ? `\n${tail}` : ""}`);
      }
      if (notes.length > 0) result = appendToResult(result, `\n\n${notes.join("\n\n")}`);
      return result;
    },
  };
}

function safeGet(getHooks: () => HooksRuntime | undefined): HooksRuntime | undefined {
  try {
    return getHooks();
  } catch {
    return undefined;
  }
}

/** A tool result that is already an error: post hooks (format, lint) would only add noise. */
function isErrorResult(result: ToolExecuteResult): boolean {
  const text =
    typeof result === "string"
      ? result
      : typeof result.content === "string"
        ? result.content
        : ((result.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text ??
          "");
  return text.startsWith("Error:");
}
