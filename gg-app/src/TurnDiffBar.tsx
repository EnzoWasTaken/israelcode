import { useState } from "react";
import { revertTurnFiles, type TurnFileDiff } from "./agent";
import { toast } from "./toast";

function lineClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-file";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return undefined;
}

function Patch({ patch }: { patch: string }): React.ReactElement {
  return (
    <pre className="turn-diff-patch">
      {patch.split("\n").map((line, i) => (
        <span key={i} className={lineClass(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

const STATUS: Record<TurnFileDiff["status"], string> = {
  added: "new",
  modified: "",
  deleted: "deleted",
};

/**
 * What a turn changed, under its reply: "3 files changed +12 −4", each file
 * expandable to its diff, with Revert per file or for all. Only the latest
 * turn can be reverted (the sidecar refuses older ones and running agents).
 */
export function TurnDiffBar({
  checkpointId,
  files,
}: {
  checkpointId: string;
  files: readonly TurnFileDiff[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const live = files.filter((f) => !reverted.has(f.path));
  const additions = live.reduce((n, f) => n + f.additions, 0);
  const deletions = live.reduce((n, f) => n + f.deletions, 0);

  async function revert(paths?: string[]): Promise<void> {
    setBusy(true);
    try {
      await revertTurnFiles(checkpointId, paths);
      setReverted((prev) => new Set([...prev, ...(paths ?? files.map((f) => f.path))]));
    } catch (e) {
      toast(`Couldn't revert: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const toggleFile = (p: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <section className="turn-diff" aria-label="Changes in this turn">
      <div className="turn-diff-head">
        <button
          type="button"
          className="turn-diff-summary"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {live.length === 0
            ? "All changes reverted"
            : `${live.length} file${live.length === 1 ? "" : "s"} changed`}
          {live.length > 0 && (
            <>
              <span className="diff-add">{` +${additions}`}</span>
              <span className="diff-del">{` \u2212${deletions}`}</span>
            </>
          )}
        </button>
        {live.length > 0 && (
          <button
            type="button"
            className="turn-diff-revert"
            disabled={busy}
            onClick={() => void revert(reverted.size > 0 ? live.map((f) => f.path) : undefined)}
          >
            Revert all
          </button>
        )}
      </div>
      {open && (
        <ul className="turn-diff-files">
          {files.map((f) => {
            const gone = reverted.has(f.path);
            return (
              <li key={f.path} className="turn-diff-file" data-reverted={gone || undefined}>
                <div className="turn-diff-file-head">
                  <button
                    type="button"
                    className="turn-diff-path"
                    aria-expanded={expanded.has(f.path)}
                    disabled={!f.patch}
                    onClick={() => toggleFile(f.path)}
                  >
                    {f.path}
                    {STATUS[f.status] && (
                      <span className="turn-diff-status">{STATUS[f.status]}</span>
                    )}
                    {f.binary ? (
                      <span className="turn-diff-status">binary</span>
                    ) : (
                      <>
                        <span className="diff-add">{` +${f.additions}`}</span>
                        <span className="diff-del">{` \u2212${f.deletions}`}</span>
                      </>
                    )}
                  </button>
                  {gone ? (
                    <span className="turn-diff-status">reverted</span>
                  ) : (
                    <button
                      type="button"
                      className="turn-diff-revert"
                      disabled={busy}
                      aria-label={`Revert ${f.path}`}
                      onClick={() => void revert([f.path])}
                    >
                      Revert
                    </button>
                  )}
                </div>
                {expanded.has(f.path) && f.patch && !gone && <Patch patch={f.patch} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
