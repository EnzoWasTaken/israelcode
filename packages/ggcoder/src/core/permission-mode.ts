import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import path from "node:path";
import { isReadOnlyCommand } from "../tools/read-only-bash.js";

/**
 * Permission modes for the coding agent. `bypass` is the long-standing
 * behaviour (nothing asks). `ask` holds file edits and state-changing shell
 * commands for the user's approval; `accept-edits` lets edits through and
 * still asks for commands. Plan mode is separate (it already blocks writes).
 */
export const PERMISSION_MODES = ["bypass", "ask", "accept-edits"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Tools the gate holds. */
export const GATED_TOOLS = ["write", "edit", "bash"] as const;
export type GatedTool = (typeof GATED_TOOLS)[number];

export interface ApprovalRequest {
  tool: GatedTool;
  /** bash: the command line. */
  command?: string;
  /** write/edit: the files, relative to the project where possible. */
  paths?: string[];
  /** What would change, trimmed for display. */
  preview?: string;
  /** The sub-agent asking, when it isn't the main agent. */
  agentName?: string;
}

export interface ApprovalDecision {
  decision: "allow" | "always" | "deny";
  /** The user's reason for a deny, passed back to the model. */
  note?: string;
}

/** How long a call waits for the user before it is denied. */
export const APPROVAL_WAIT_MS = 30 * 60_000;
const PREVIEW_CHARS = 4000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text;
}

function display(cwd: string, file: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? rel.split(path.sep).join("/")
    : file;
}

function prefixed(text: string, mark: "-" | "+"): string {
  return text
    .split("\n")
    .map((line) => `${mark} ${line}`)
    .join("\n");
}

type Args = Record<string, unknown>;

function editPreview(args: Args, cwd: string): { paths: string[]; preview: string } {
  const files: Array<{ file_path?: unknown; edits?: unknown }> = Array.isArray(args.files)
    ? (args.files as Args[])
    : [{ file_path: args.file_path, edits: args.edits }];
  const paths: string[] = [];
  const parts: string[] = [];
  for (const f of files) {
    const file = typeof f.file_path === "string" ? display(cwd, f.file_path) : "(unknown file)";
    paths.push(file);
    parts.push(`--- ${file}`);
    for (const e of Array.isArray(f.edits) ? (f.edits as Args[]) : []) {
      if (typeof e.old_text === "string") parts.push(prefixed(e.old_text, "-"));
      if (Array.isArray(e.lines)) parts.push(prefixed((e.lines as string[]).join("\n"), "+"));
      else if (typeof e.new_text === "string") parts.push(prefixed(e.new_text, "+"));
    }
  }
  return { paths, preview: clip(parts.join("\n")) };
}

/**
 * The approval a tool call needs under `mode`, or null when it may run.
 * Read-only shell commands never ask.
 */
export function approvalNeeded(
  mode: PermissionMode,
  tool: string,
  args: unknown,
  cwd: string,
): ApprovalRequest | null {
  if (mode === "bypass") return null;
  const a = (args && typeof args === "object" ? args : {}) as Args;
  if (tool === "bash") {
    const command = typeof a.command === "string" ? a.command : "";
    if (command && isReadOnlyCommand(command)) return null;
    return { tool: "bash", command, preview: command };
  }
  if (mode === "accept-edits") return null;
  if (tool === "write") {
    const file = typeof a.file_path === "string" ? display(cwd, a.file_path) : "(unknown file)";
    const content = typeof a.content === "string" ? a.content : "";
    return {
      tool: "write",
      paths: [file],
      preview: clip(`+++ ${file}\n${prefixed(content, "+")}`),
    };
  }
  if (tool === "edit") return { tool: "edit", ...editPreview(a, cwd) };
  return null;
}

/** The result text the model gets for a denied call. */
export function deniedText(request: ApprovalRequest, note?: string): string {
  const what = request.tool === "bash" ? "this command" : "this change";
  const reason = note?.trim() ? ` Their note: ${note.trim()}` : "";
  return `Error: The user declined ${what}, so it did not run.${reason} Adjust the approach or ask them.`;
}

export type ToolAuthorizer = (
  tool: GatedTool,
  args: unknown,
  signal: AbortSignal,
) => Promise<ApprovalDecision | null>;

/**
 * Wrap a gated tool so each call is authorized first. `authorize` returns null
 * when no approval is needed. Same name, description and schema (cache-stable).
 */
export function wrapWithApproval(tool: AgentTool, authorize: ToolAuthorizer): AgentTool {
  if (!(GATED_TOOLS as readonly string[]).includes(tool.name)) return tool;
  const name = tool.name as GatedTool;
  const ceiling = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return {
    ...tool,
    // The loop's ceiling also covers the wait for the user; the tool's own
    // ceiling is applied below once the call is approved.
    timeoutMs: Number.isFinite(ceiling) ? ceiling + APPROVAL_WAIT_MS : ceiling,
    async execute(args: unknown, context: ToolContext) {
      const decision = await authorize(name, args, context.signal);
      if (decision && decision.decision === "deny") {
        const request = { tool: name } as ApprovalRequest;
        return deniedText(request, decision.note);
      }
      if (!decision || !Number.isFinite(ceiling)) return tool.execute(args as never, context);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(ceiling)]);
      return tool.execute(args as never, { ...context, signal });
    },
  };
}

// ── The model's picture of the mode: appended notices, never a prompt rebuild ──

const NOTICE = "Permission mode is now ";

export function buildPermissionNotice(mode: PermissionMode): Message {
  const line =
    mode === "ask"
      ? "ASK: file edits and state-changing shell commands wait for the user's approval. If one is declined, read their note and adjust; don't retry the same call."
      : mode === "accept-edits"
        ? "ACCEPT EDITS: file edits run directly; state-changing shell commands wait for the user's approval. If one is declined, read their note and adjust."
        : "BYPASS: tools run without asking.";
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content: `${NOTICE}${line}\nDo not restate this note; just proceed.`,
  };
}

/** The mode a message announces, or null when it isn't a mode notice. */
export function permissionNoticeState(m: Message | undefined): PermissionMode | null {
  if (m?.role !== "user" || typeof m.content !== "string" || !m.content.startsWith(NOTICE))
    return null;
  const word = m.content.slice(NOTICE.length).split(":")[0];
  return word === "ASK" ? "ask" : word === "ACCEPT EDITS" ? "accept-edits" : "bypass";
}

/** What the newest mode notice in a history said (none = bypass). */
export function lastPermissionMode(messages: readonly Message[]): PermissionMode {
  for (let i = messages.length - 1; i >= 0; i--) {
    const state = permissionNoticeState(messages[i]);
    if (state !== null) return state;
  }
  return "bypass";
}
