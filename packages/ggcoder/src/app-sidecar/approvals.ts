import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "../core/permission-mode.js";

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: number;
}

/**
 * The app's side of permission-mode approvals: a held tool call becomes an
 * `approval_request` card; the webview answers with POST /approval. A command
 * the user chose to always allow (in this project) is answered straight away.
 */
export function createApprovalBridge(options: {
  broadcast: (event: "approval_request" | "approval_resolved", data: unknown) => void;
  isAlwaysAllowed: (command: string) => Promise<boolean>;
  rememberAlways: (command: string) => Promise<void>;
}) {
  const pending = new Map<
    string,
    { approval: PendingApproval; resolve: (d: ApprovalDecision) => void }
  >();

  const settle = (id: string, decision: ApprovalDecision): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    options.broadcast("approval_resolved", { id, decision: decision.decision });
    entry.resolve(decision);
    return true;
  };

  return {
    async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
      if (
        request.tool === "bash" &&
        request.command &&
        (await options.isAlwaysAllowed(request.command))
      )
        return { decision: "allow" };
      if (signal.aborted) return { decision: "deny", note: "The run was stopped." };
      const approval: PendingApproval = { ...request, id: randomUUID(), createdAt: Date.now() };
      return new Promise<ApprovalDecision>((resolve) => {
        pending.set(approval.id, { approval, resolve });
        signal.addEventListener(
          "abort",
          () => settle(approval.id, { decision: "deny", note: "The run was stopped." }),
          { once: true },
        );
        options.broadcast("approval_request", approval);
      });
    },

    /** The user's answer. False when the request is no longer waiting. */
    async answer(id: string, decision: ApprovalDecision): Promise<boolean> {
      const entry = pending.get(id);
      if (!entry) return false;
      if (
        decision.decision === "always" &&
        entry.approval.tool === "bash" &&
        entry.approval.command
      )
        await options.rememberAlways(entry.approval.command);
      return settle(id, decision);
    },

    /** Requests still waiting, oldest first (a reloaded window shows them again). */
    list(): PendingApproval[] {
      return [...pending.values()].map((p) => p.approval);
    },
  };
}

export type ApprovalBridge = ReturnType<typeof createApprovalBridge>;
