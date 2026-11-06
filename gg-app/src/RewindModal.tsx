import { useEffect, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { listRewindPoints, rewindTo, type RewindMode, type RewindPoint } from "./agent";

const MODES: ReadonlyArray<{ id: RewindMode; label: string; hint: string }> = [
  { id: "both", label: "Code and conversation", hint: "Undo the file changes and the messages" },
  { id: "conversation", label: "Conversation only", hint: "Keep the files as they are now" },
  { id: "code", label: "Code only", hint: "Keep the messages; undo the file changes" },
];

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Go back to just before an earlier prompt. Lists the session's rewind points
 * (newest first); `initialPrompt` preselects the one a message's Rewind button
 * was pressed on. Files changed by shell commands aren't tracked.
 */
export function RewindModal({
  initialPrompt,
  onClose,
  onRewound,
}: {
  initialPrompt?: string;
  onClose: () => void;
  onRewound: (result: { mode: RewindMode; prompt: string; filesRestored: number }) => void;
}): React.ReactElement {
  const [points, setPoints] = useState<RewindPoint[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<RewindMode>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listRewindPoints()
      .then((list) => {
        if (!live) return;
        const newestFirst = [...list].reverse();
        setPoints(newestFirst);
        const match = initialPrompt
          ? newestFirst.find((p) => (p.prompt ?? "").trim() === initialPrompt.trim())
          : undefined;
        setSelected((match ?? newestFirst[0])?.id ?? null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [initialPrompt]);

  const chosen = points?.find((p) => p.id === selected);

  async function rewind(): Promise<void> {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rewindTo(chosen.id, mode);
      onRewound({ mode, prompt: result.prompt, filesRestored: result.filesRestored });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Rewind" onClose={onClose} className="rewind-modal">
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        Go back to just before a message. Changes made by shell commands can&apos;t be undone.
      </div>
      {points === null && !error && (
        <div className="modal-hint" style={{ color: theme.textDim }}>
          Loading…
        </div>
      )}
      {points?.length === 0 && (
        <div className="modal-hint" style={{ color: theme.textDim }}>
          Nothing to rewind yet. Each message you send becomes a point you can return to.
        </div>
      )}
      {points && points.length > 0 && (
        <>
          <div className="rewind-list" role="radiogroup" aria-label="Rewind to before">
            {points.map((p) => (
              <label
                key={p.id}
                className="rewind-point"
                data-selected={p.id === selected || undefined}
              >
                <input
                  type="radio"
                  name="rewind-point"
                  checked={p.id === selected}
                  onChange={() => setSelected(p.id)}
                />
                <span className="rewind-prompt">
                  {p.prompt?.trim() || `Message ${p.turnIndex}`}
                </span>
                <span className="rewind-meta">
                  {`${when(p.timestamp)} · ${
                    p.changedFileCount === 0
                      ? "no file changes"
                      : `${p.changedFileCount} file${p.changedFileCount === 1 ? "" : "s"}: ${p.summary}`
                  }`}
                </span>
              </label>
            ))}
          </div>
          <label className="modal-label" style={{ color: theme.textMuted }}>
            Restore
          </label>
          <div className="modal-radio-group">
            {MODES.map((m) => (
              <label
                key={m.id}
                className="modal-radio"
                title={m.hint}
                style={{ color: mode === m.id ? theme.text : theme.textMuted }}
              >
                <input
                  type="radio"
                  name="rewind-mode"
                  checked={mode === m.id}
                  onChange={() => setMode(m.id)}
                />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {error && (
        <div className="modal-hint" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        <button
          className="modal-btn primary"
          disabled={!chosen || busy}
          onClick={() => void rewind()}
        >
          {busy ? "Rewinding…" : "Rewind"}
        </button>
      </div>
    </Modal>
  );
}
