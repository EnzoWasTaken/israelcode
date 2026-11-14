import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { compactNow, setCompaction, undoCompaction, type CompactionState } from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover } from "./popover";
import { toast } from "./toast";

/** Window fractions offered as one-click thresholds (mirrors the sidecar). */
export const COMPACTION_THRESHOLD_PRESETS = [0.6, 0.7, 0.85] as const;
export const MAX_PINNED_FACTS = 20;
const PIN_SAVE_DELAY_MS = 600;

/** Textarea lines → pins: trimmed, non-empty, at most 20. */
export function parsePins(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_PINNED_FACTS);
}

/** "N% of 200k" for the popover's usage line. */
export function formatUsage(contextPct: number, contextWindow: number): string {
  return `${contextPct}% of ${Math.round(contextWindow / 1000)}k`;
}

/**
 * The deck's context gauge, now a button: its popover shows the usage, the
 * compaction trigger (60/70/85 % presets or a token count), the pinned facts
 * the summariser must keep, "Compact now" and "Undo last compaction".
 */
export function CompactionControl({
  compaction,
  contextPct,
  running,
  onChange,
  onOpenUsage,
}: {
  compaction: CompactionState;
  contextPct: number;
  /** A run is active: compaction can't be started or undone by hand. */
  running: boolean;
  onChange: (next: CompactionState) => void;
  /** Opens the deck's Usage panel (what the gauge used to do). */
  onOpenUsage?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const popoverId = useId();
  const pinsId = useId();
  const tokensId = useId();
  const { pref, info } = compaction;
  const [pinsText, setPinsText] = useState(pref.pins.join("\n"));
  const [tokensText, setTokensText] = useState(pref.atTokens ? String(pref.atTokens) : "");
  const [busy, setBusy] = useState<"compact" | "undo" | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    setPinsText(pref.pins.join("\n"));
    setTokensText(pref.atTokens ? String(pref.atTokens) : "");
  }, [open, pref.pins, pref.atTokens]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  async function save(change: Parameters<typeof setCompaction>[0]): Promise<void> {
    try {
      onChange(await setCompaction(change));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function onPinsChange(text: string): void {
    setPinsText(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save({ pins: parsePins(text) }), PIN_SAVE_DELAY_MS);
  }

  function saveTokens(): void {
    const n = Math.floor(Number(tokensText.replace(/[,_\s]/g, "")));
    if (!tokensText.trim()) {
      if (pref.atTokens !== undefined) void save({ atTokens: null });
      return;
    }
    if (!Number.isFinite(n) || n < 20_000) {
      toast("The token count must be at least 20,000.", "error");
      return;
    }
    if (n !== pref.atTokens) void save({ atTokens: n });
  }

  async function compact(): Promise<void> {
    setBusy("compact");
    try {
      const result = await compactNow();
      if (!result.compacted) toast("Nothing to compact yet.", "info");
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  }

  async function undo(): Promise<void> {
    setBusy("undo");
    try {
      const result = await undoCompaction();
      toast(`Restored ${result.restoredCount} messages.`, "success");
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  }

  const hot = contextPct >= 80;
  const activeThreshold = pref.threshold ?? info.threshold;
  const pinCount = parsePins(pinsText).length;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="key rail-key ctx-key"
        data-trophy-key=""
        data-hot={hot || undefined}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`Context: ${contextPct}% used. Compaction at ${Math.round(info.threshold * 100)}%`}
        aria-label={`Context ${contextPct}% used. Compaction`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="cbar"
          aria-hidden="true"
          style={{ "--p": contextPct } as React.CSSProperties}
        />
        <span className="well">{contextPct}%</span>
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel compaction-popover"
              data-side="below"
              role="dialog"
              aria-label="Context"
              style={style}
            >
              <h2 className="pop-title">Context</h2>
              <p className="compaction-usage">
                {formatUsage(contextPct, info.contextWindow)}
                {onOpenUsage && (
                  <>
                    {" · "}
                    <button type="button" className="key key-sm" onClick={onOpenUsage}>
                      Usage
                    </button>
                  </>
                )}
              </p>
              <div className="compaction-field" role="group" aria-label="Compact at">
                <span>Compact at</span>
                <span className="compaction-presets">
                  {COMPACTION_THRESHOLD_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="key key-sm"
                      aria-pressed={Math.abs(activeThreshold - preset) < 0.005}
                      onClick={() => void save({ threshold: preset })}
                    >
                      {Math.round(preset * 100)}%
                    </button>
                  ))}
                </span>
              </div>
              <label className="compaction-field" htmlFor={tokensId}>
                or at tokens
                <input
                  id={tokensId}
                  type="text"
                  inputMode="numeric"
                  placeholder="400000"
                  value={tokensText}
                  onChange={(e) => setTokensText(e.target.value)}
                  onBlur={saveTokens}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTokens();
                  }}
                />
              </label>
              <label className="compaction-field compaction-pins-label" htmlFor={pinsId}>
                Keep verbatim ({pinCount}/{MAX_PINNED_FACTS})
              </label>
              <textarea
                id={pinsId}
                className="compaction-pins"
                rows={4}
                spellCheck={false}
                value={pinsText}
                placeholder={"One fact or decision per line\nThe API lives in src/api.ts"}
                onChange={(e) => onPinsChange(e.target.value)}
              />
              <div className="compaction-actions">
                <button
                  type="button"
                  className="key key-sm"
                  disabled={running || busy !== null || !info.lastCompactionRewindId}
                  title={
                    info.lastCompactionRewindId
                      ? "Put the conversation back as it was before the last compaction"
                      : "No compaction to undo yet"
                  }
                  onClick={() => void undo()}
                >
                  {busy === "undo" ? "Undoing…" : "Undo last compaction"}
                </button>
                <button
                  type="button"
                  className="key key-sm"
                  disabled={running || busy !== null}
                  title={running ? "Wait for the current run to finish" : undefined}
                  onClick={() => void compact()}
                >
                  {busy === "compact" ? "Compacting…" : "Compact now"}
                </button>
              </div>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}
