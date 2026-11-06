import { useEffect, useRef, useState } from "react";
import type { PendingApproval } from "./agent";

const TITLE: Record<PendingApproval["tool"], string> = {
  bash: "Run this command?",
  edit: "Make this edit?",
  write: "Write this file?",
};

/**
 * The oldest held tool call, above the composer. Allow once, always allow this
 * exact command in the project, or deny with a note the agent reads.
 */
export function ApprovalCard({
  approvals,
  onAnswer,
}: {
  approvals: readonly PendingApproval[];
  onAnswer: (id: string, decision: "allow" | "always" | "deny", note?: string) => void;
}): React.ReactElement | null {
  const approval = approvals[0];
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const id = approval?.id;
  useEffect(() => {
    setDenying(false);
    setNote("");
  }, [id]);
  useEffect(() => {
    if (denying) noteRef.current?.focus();
  }, [denying]);
  if (!approval) return null;
  const subject =
    approval.tool === "bash" ? approval.command : (approval.paths ?? []).join(", ") || undefined;
  return (
    <section className="approval-card" role="alertdialog" aria-label={TITLE[approval.tool]}>
      <div className="approval-head">
        <span className="approval-title">{TITLE[approval.tool]}</span>
        {approval.agentName && <span className="approval-agent">{approval.agentName}</span>}
        {approvals.length > 1 && (
          <span className="approval-count">{`1 of ${approvals.length}`}</span>
        )}
      </div>
      {subject && approval.tool !== "bash" && <div className="approval-subject">{subject}</div>}
      {approval.preview && <pre className="approval-preview">{approval.preview}</pre>}
      {denying ? (
        <form
          className="approval-actions"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(approval.id, "deny", note);
          }}
        >
          <input
            ref={noteRef}
            className="approval-note"
            aria-label="What should the agent do instead? (optional)"
            placeholder="What should it do instead? (optional)"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDenying(false);
            }}
          />
          <button type="submit" className="modal-btn primary">
            Deny
          </button>
        </form>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => onAnswer(approval.id, "allow")}
          >
            Allow once
          </button>
          {approval.tool === "bash" && approval.command && (
            <button
              type="button"
              className="modal-btn"
              title="Run this exact command without asking again in this project"
              onClick={() => onAnswer(approval.id, "always")}
            >
              Always allow
            </button>
          )}
          <button type="button" className="modal-btn" onClick={() => setDenying(true)}>
            Deny…
          </button>
        </div>
      )}
    </section>
  );
}
