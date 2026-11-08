import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./Badge";
import { ConfirmModal } from "./ConfirmModal";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover, useScrollEdges } from "./popover";
import { toast } from "./toast";
import {
  deleteBackgroundSession,
  dismissBackgroundSession,
  listBackgroundSessions,
  onBackgroundSessions,
  restoreTarget,
  stopBackgroundSession,
  type BackgroundSessionRow,
  type BackgroundSessionStatus,
} from "./agent";
import "./BackgroundSessions.css";

const ACTIVE: ReadonlySet<BackgroundSessionStatus> = new Set(["running", "awaiting_input"]);
const FINISHED: ReadonlySet<BackgroundSessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const isActive = (row: BackgroundSessionRow): boolean => ACTIVE.has(row.status);
const isFinished = (row: BackgroundSessionRow): boolean => FINISHED.has(row.status);

/** Colour tokens only: the dot is the status signal, the words carry the meaning. */
const STATUS_DOT: Record<BackgroundSessionStatus, string | undefined> = {
  running: "var(--primary)",
  awaiting_input: "var(--warning)",
  completed: "var(--success)",
  failed: "var(--error)",
  cancelled: undefined,
  interrupted: undefined,
  idle: undefined,
};

const STATUS_WORD: Record<BackgroundSessionStatus, string> = {
  running: "Running",
  awaiting_input: "Needs you",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  idle: "Idle",
};

/** The pill word and the quiet line under it. */
export function describeStatus(row: BackgroundSessionRow): { word: string; note: string | null } {
  const word = STATUS_WORD[row.status];
  const detail = row.detail?.trim() || null;
  switch (row.status) {
    case "awaiting_input":
      return { word, note: detail ?? "Waiting for you" };
    case "failed":
      return { word, note: detail && detail.length > 90 ? `${detail.slice(0, 89)}\u2026` : detail };
    case "interrupted":
      return { word, note: "Israel Code was closed" };
    default:
      return { word, note: null };
  }
}

export function projectName(cwd: string): string {
  const parts = cwd.split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function rowTitle(row: BackgroundSessionRow): string {
  return row.title.trim() || projectName(row.cwd) || "Untitled conversation";
}

const MODE_WORD = { code: "Code", chat: "Chat", motion: "Motion" } as const;

export function relativeTime(then: number, now: number): string {
  if (!then) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const ORDER: Record<BackgroundSessionStatus, number> = {
  awaiting_input: 0,
  running: 1,
  failed: 2,
  completed: 2,
  interrupted: 2,
  cancelled: 2,
  idle: 3,
};

/** Rows worth listing: active and finished ones (an idle live session is not news), most urgent first. */
export function listableRows(rows: readonly BackgroundSessionRow[]): BackgroundSessionRow[] {
  return rows
    .filter((r) => isActive(r) || isFinished(r))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt);
}

/** "1 needs you · 2 running", or null when nothing is active. */
export function activeSummary(rows: readonly BackgroundSessionRow[]): string | null {
  const needs = rows.filter((r) => r.status === "awaiting_input").length;
  const running = rows.filter((r) => r.status === "running").length;
  const parts = [
    needs > 0 ? `${needs} needs you` : null,
    running > 0 ? `${running} running` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" \u00b7 ") : null;
}

const rowKey = (r: BackgroundSessionRow): string => r.id ?? r.sessionPath ?? `${r.cwd}:${r.mode}`;

/** The daemon's session list, live. Empty until the daemon answers (or if it never does). */
export function useBackgroundSessions(): BackgroundSessionRow[] {
  const [rows, setRows] = useState<BackgroundSessionRow[]>([]);
  useEffect(() => {
    let live = true;
    // A push can land before the first list returns; never let the older answer win.
    let pushed = false;
    const off = onBackgroundSessions((next) => {
      pushed = true;
      setRows(next);
    });
    void listBackgroundSessions()
      .then((first) => {
        if (live && !pushed) setRows(first);
      })
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return rows;
}

/** This window's own conversation file (null on a fresh window). Refreshed when the list changes. */
export function useOwnSessionPath(rows: readonly BackgroundSessionRow[]): string | null {
  const [own, setOwn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void restoreTarget()
      .then((t) => live && setOwn(t?.sessionPath ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rows]);
  return own;
}

const SEEN_KEY = "gg-bg-handoff-seen";

/** First time a running task is left behind: say where it went. Once, ever. */
export function noteBackgroundHandoff(): void {
  try {
    if (localStorage.getItem(SEEN_KEY)) return;
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Storage unavailable: still tell them once per run.
  }
  toast("Still running in the background. Find it under Background.", "info");
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface ListProps {
  rows: readonly BackgroundSessionRow[];
  /** Reattach/reopen this conversation in the current window. */
  onOpen: (row: BackgroundSessionRow) => Promise<void> | void;
  /** This window's own conversation file. */
  ownSessionPath?: string | null;
  /** Leave this window's own conversation out (the workspace indicator). Home keeps it. */
  hideOwn?: boolean;
  /** Called after a row action so a popover can close. */
  onActed?: () => void;
  className?: string;
}

/** The compact list. Pure of layout: Home and the workspace popover each wrap it. */
export function BackgroundSessionList({
  rows,
  onOpen,
  ownSessionPath = null,
  hideOwn = false,
  onActed,
  className,
}: ListProps): React.ReactElement | null {
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BackgroundSessionRow | null>(null);
  const shown = useMemo(
    () =>
      listableRows(rows).filter(
        (r) => !(hideOwn && ownSessionPath && r.sessionPath === ownSessionPath),
      ),
    [rows, hideOwn, ownSessionPath],
  );

  // Announce changes, not the whole list: a status counts once it differs from the last one heard.
  const announced = useRef<Map<string, BackgroundSessionStatus>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const prev = announced.current;
    const next = new Map<string, BackgroundSessionStatus>();
    const said: string[] = [];
    for (const r of shown) {
      next.set(rowKey(r), r.status);
      const before = prev.get(rowKey(r));
      if (prev.size > 0 && before !== r.status) {
        said.push(`${rowTitle(r)}: ${describeStatus(r).word.toLowerCase()}`);
      }
    }
    announced.current = next;
    if (said.length > 0) setAnnouncement(said.join(". "));
  }, [shown]);

  async function act(row: BackgroundSessionRow, run: () => Promise<void>, failure: string) {
    const key = rowKey(row);
    if (busy) return;
    setBusy(key);
    try {
      await run();
      onActed?.();
    } catch (e) {
      toast(`${failure}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  const target = (r: BackgroundSessionRow): { id?: string; sessionPath?: string } => ({
    ...(r.id ? { id: r.id } : {}),
    ...(r.sessionPath ? { sessionPath: r.sessionPath } : {}),
  });

  if (shown.length === 0) {
    return <span className="sr-only" role="status" aria-live="polite" />;
  }

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <ul className={className ? `bgs-list ${className}` : "bgs-list"}>
        {shown.map((row) => {
          const { word, note } = describeStatus(row);
          const key = rowKey(row);
          const elsewhere = row.attached && row.sessionPath !== ownSessionPath;
          const title = rowTitle(row);
          const disabled = busy !== null;
          return (
            <li key={key} className="bgs-row" data-status={row.status}>
              <div className="bgs-main">
                <span className="bgs-title" title={title}>
                  {title}
                </span>
                <span className="bgs-meta">
                  <span className="bgs-where" title={row.cwd}>
                    {projectName(row.cwd)} {"\u00b7"} {MODE_WORD[row.mode]}
                  </span>
                  <span className="bgs-when">{relativeTime(row.updatedAt, now)}</span>
                </span>
                <span className="bgs-state">
                  <Badge color={STATUS_DOT[row.status]} className="bgs-pill">
                    {word}
                  </Badge>
                  {note && <span className="bgs-note">{note}</span>}
                </span>
              </div>
              <div className="bgs-actions">
                {elsewhere ? (
                  <span className="bgs-elsewhere">Open in another window</span>
                ) : (
                  row.sessionPath && (
                    <button
                      type="button"
                      className="bgs-btn bgs-open"
                      disabled={disabled}
                      aria-label={`Open ${title}`}
                      onClick={() => void act(row, async () => onOpen(row), "Couldn't open it")}
                    >
                      Open
                    </button>
                  )
                )}
                {isActive(row) && row.id && (
                  <button
                    type="button"
                    className="bgs-btn bgs-stop"
                    disabled={disabled}
                    aria-label={`Stop task: ${title}`}
                    onClick={() =>
                      void act(
                        row,
                        () => stopBackgroundSession(row.id as string),
                        "Couldn't stop it",
                      )
                    }
                  >
                    Stop task
                  </button>
                )}
                {isFinished(row) && (
                  <button
                    type="button"
                    className="bgs-btn"
                    disabled={disabled}
                    title="Takes it off this list. The conversation stays in your history."
                    aria-label={`Remove from list: ${title}`}
                    onClick={() =>
                      void act(
                        row,
                        () => dismissBackgroundSession(target(row)),
                        "Couldn't remove it",
                      )
                    }
                  >
                    Remove from list
                  </button>
                )}
                <button
                  type="button"
                  className="bgs-btn bgs-delete"
                  disabled={disabled}
                  aria-label={`Delete conversation: ${title}`}
                  onClick={() => setConfirming(row)}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {confirming && (
        <ConfirmModal
          title="Delete this conversation?"
          message="Stops any work and deletes this conversation. This can't be undone."
          confirmLabel="Delete"
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const row = confirming;
            setConfirming(null);
            void act(row, () => deleteBackgroundSession(target(row)), "Couldn't delete it");
          }}
        />
      )}
    </>
  );
}

/**
 * Title-bar indicator: appears only while OTHER sessions are running or need
 * you. A dot and a few words; the popover holds the list.
 */
export function BackgroundIndicator({
  onOpen,
}: {
  onOpen: (row: BackgroundSessionRow) => Promise<void> | void;
}): React.ReactElement | null {
  const rows = useBackgroundSessions();
  const own = useOwnSessionPath(rows);
  const others = useMemo(() => rows.filter((r) => !(own && r.sessionPath === own)), [rows, own]);
  const summary = activeSummary(others);
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const headingId = useId();
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  const needsYou = others.some((r) => r.status === "awaiting_input");
  const visible = summary !== null;
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  if (!visible) return null;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="key key-sm bgs-indicator"
        data-attention={needsYou || undefined}
        data-open={open || undefined}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Background sessions: ${summary}`}
        title="Other conversations working in the background"
        onClick={() => setOpen((o) => !o)}
      >
        <i className="bgs-dot" aria-hidden="true" />
        <span className="bgs-indicator-text">{summary.split(" \u00b7 ")[0]}</span>
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel bgs-panel"
              data-side="below"
              role="dialog"
              aria-labelledby={headingId}
              style={style}
            >
              <header className="pop-head">
                <h2 id={headingId} className="pop-title">
                  Background
                </h2>
                <span className="pop-count">{summary}</span>
              </header>
              <div
                ref={scrollRef}
                className="pop-scroll pop-body"
                tabIndex={-1}
                data-pop-focus
                onScroll={onScroll}
              >
                <BackgroundSessionList
                  rows={others}
                  ownSessionPath={own}
                  hideOwn
                  onOpen={onOpen}
                  onActed={close}
                />
              </div>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}

/** Home's short "Background" section; renders nothing when there is nothing to show. */
export function BackgroundSection({
  onOpen,
}: {
  onOpen: (row: BackgroundSessionRow) => Promise<void> | void;
}): React.ReactElement | null {
  const rows = useBackgroundSessions();
  const own = useOwnSessionPath(rows);
  const count = listableRows(rows).length;
  const headingId = useId();
  if (count === 0) return null;
  return (
    <section className="bgs-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="bgs-section-title">
        Background
        <span className="bgs-section-count">{activeSummary(rows) ?? `${count} finished`}</span>
      </h2>
      <div className="bgs-section-body pop-scroll">
        <BackgroundSessionList rows={rows} ownSessionPath={own} onOpen={onOpen} />
      </div>
    </section>
  );
}
