import type http from "node:http";
import type { AgentSession } from "../core/agent-session.js";
import type { ChatAgentId } from "../chat-agents/index.js";
import type { ChildProcess } from "node:child_process";
import type { PullPhase } from "../hf-pull.js";

export interface SseClient {
  id: number;
  res: http.ServerResponse;
}

export type WorkspaceMode = "code" | "chat" | "motion";

/** Unknown or missing modes fall back to the coding agent. */
export function parseWorkspaceMode(value: unknown): WorkspaceMode {
  return value === "chat" || value === "motion" ? value : "code";
}

/** What a context is doing, as the background-sessions registry reads it. */
export interface ContextStatus {
  state: "running" | "awaiting_input" | "completed" | "failed" | "cancelled" | "idle";
  /** Short human line ("Waiting for your approval"); never raw provider text. */
  detail: string | null;
  /** First user message (or empty), already bounded to a short title. */
  title: string;
  startedAt: number | null;
  updatedAt: number;
}

export interface SessionContext {
  id: string;
  mode: WorkspaceMode;
  chatAgent: ChatAgentId;
  cwd: string;
  sessionPath?: string;
  session: AgentSession;
  clients: Set<SseClient>;
  broadcast: (type: string, data: unknown) => void;
  /** Handle one HTTP request for this session. Owns its own 404 fallthrough. */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => void;
  dispose: () => Promise<void>;
  /** Synchronously stop this context's background commands (all its sessions). */
  stopBackgroundProcesses: () => void;
  /** Current status snapshot (run, pending approval / question / plan, last outcome). */
  status: () => ContextStatus;
  /**
   * Mark the window gone (true) or back (false). While detached, ask_user
   * deadlines are suspended so a question waits for the user to return.
   */
  setDetached: (detached: boolean) => void;
  /** Stop the active run the way the window's Stop button does. */
  stop: () => Promise<"cancelled" | "idle" | "failed">;
  /** Working right now: a run in progress, or a worker still on a task. */
  isBusy: () => boolean;
  /**
   * The folder this window reads git state from (a Goal window: its project
   * folder, not the goal folder). Absent for contexts without git state.
   */
  gitDir?: () => string;
}

export interface HfPullState {
  repo: string;
  model: string;
  tag: string | null;
  file: string;
  sizeBytes: number;
  phase: PullPhase;
  percent: number;
  detail?: string;
  error?: string;
  child: ChildProcess | null;
}
