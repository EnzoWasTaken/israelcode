import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  listBackgroundSessions,
  onBackgroundSessions,
  type BackgroundSessionRow,
  type RecentSession,
} from "./agent";
import { BackButton } from "./BackButton";
import { EmptyState } from "./EmptyState";
import { isMacPlatform } from "./platform";
import { ListSkeleton } from "./Skeleton";
import { sourceStyle } from "./source-style";
import {
  CHAT_AGENT_LABELS,
  formatSessionTime,
  groupSessions,
  searchSessions,
  sessionPathKey,
} from "./session-browser-model";

/** Which field the filter chips split the list by. */
export type SessionFilterField = "source" | "chatAgent";

interface Props {
  /** Page title, in the display face (project name, Chats, Motion). */
  title: string;
  /** Singular and plural nouns for the count ("session"/"sessions"). */
  noun: { one: string; many: string };
  sessions: RecentSession[];
  loading: boolean;
  /** An open/start is in flight: rows and New are disabled. */
  busy: boolean;
  newLabel: string;
  newDisabled?: boolean;
  onNew: () => void;
  onBack?: () => void;
  backLabel?: string;
  onOpen: (session: RecentSession) => void;
  /** Absent hides "New window" and Ctrl/⌘+Enter. */
  onOpenInNewWindow?: (session: RecentSession) => void;
  filterBy: SessionFilterField;
  /** Extra header buttons after New (radio, window layout). */
  headActions?: ReactNode;
  /** Errors shown above the list. */
  notices?: ReactNode;
  /** Shown instead of the list when there are no sessions (and no load error). */
  empty?: ReactNode;
  /** Shown under the list (a project's worktrees). */
  footer?: ReactNode;
  /** Extra tooltip line for a row (e.g. "opens as an Israel Code session"). */
  rowNote?: (session: RecentSession) => string | undefined;
}

const RUNNING = "__running";

function filterValue(session: RecentSession, field: SessionFilterField): string {
  return field === "source" ? (session.source ?? "ggcoder") : (session.chatAgent ?? "general");
}

function filterLabel(value: string, field: SessionFilterField): string {
  if (field === "source") return sourceStyle(value).label;
  return CHAT_AGENT_LABELS[value as keyof typeof CHAT_AGENT_LABELS] ?? value;
}

const isForeign = (s: RecentSession): boolean => s.source === "claude-code" || s.source === "codex";

/** Paths of sessions running in the background, live from the daemon. */
function useRunningPaths(): Set<string> {
  const [rows, setRows] = useState<BackgroundSessionRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listBackgroundSessions()
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch(() => undefined);
    const off = onBackgroundSessions((list) => setRows(list));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return useMemo(
    () =>
      new Set(
        rows.flatMap((row) =>
          row.status === "running" && row.sessionPath ? [sessionPathKey(row.sessionPath)] : [],
        ),
      ),
    [rows],
  );
}

/** Is focus in a text field other than our own search? Then keys aren't ours. */
function typingElsewhere(target: EventTarget | null, search: HTMLInputElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === search) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The past-sessions page shared by the project, chat and Motion pickers: a
 * searchable, filterable, date-grouped listbox driven by the keyboard.
 */
export function SessionBrowser({
  title,
  noun,
  sessions,
  loading,
  busy,
  newLabel,
  newDisabled,
  onNew,
  onBack,
  backLabel = "Back",
  onOpen,
  onOpenInNewWindow,
  filterBy,
  headActions,
  notices,
  empty,
  footer,
  rowNote,
}: Props): React.ReactElement {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const running = useRunningPaths();
  const isRunning = (s: RecentSession): boolean => running.has(sessionPathKey(s.path));
  const mod = isMacPlatform() ? "\u2318" : "Ctrl";

  // Chips: All plus one per value present, and Running when any row runs.
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const value = filterValue(s, filterBy);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const runningCount = sessions.filter((s) => running.has(sessionPathKey(s.path))).length;
    const values = [...counts].map(([value, count]) => ({
      value,
      label: filterLabel(value, filterBy),
      count,
    }));
    if (values.length < 2 && runningCount === 0) return [];
    return [
      ...(values.length > 1 ? values : []),
      ...(runningCount > 0 ? [{ value: RUNNING, label: "Running", count: runningCount }] : []),
    ];
  }, [sessions, filterBy, running]);
  // A filter whose chip disappeared (its last row went away) falls back to All.
  const activeFilter = chips.some((c) => c.value === filter) ? filter : null;

  const visible = useMemo(() => {
    const filtered = sessions.filter((s) => {
      if (activeFilter === null) return true;
      if (activeFilter === RUNNING) return running.has(sessionPathKey(s.path));
      return filterValue(s, filterBy) === activeFilter;
    });
    return searchSessions(filtered, query);
  }, [sessions, activeFilter, running, filterBy, query]);
  // Times are read against when the list last arrived, refreshed with it.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => setNow(new Date()), [sessions]);
  const groups = useMemo(() => groupSessions(visible, now), [visible, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.sessions), [groups]);
  const current = Math.min(selected, Math.max(0, flat.length - 1));
  const selectedSession = flat[current];
  const rowId = (index: number): string => `${listId}-row-${index}`;

  // The top match is selected whenever the search or filter changes.
  useEffect(() => setSelected(0), [query, activeFilter]);

  useEffect(() => {
    const el = document.getElementById(rowId(current));
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function open(session: RecentSession | undefined, newWindow: boolean): void {
    if (!session || busy) return;
    if (newWindow) onOpenInNewWindow?.(session);
    else onOpen(session);
  }

  // Page keys: / focuses search, arrows/Home/End move, Enter opens, Esc clears
  // the search first and goes back once it's empty.
  const keyState = useRef({ flat, current, query, busy, onBack, open });
  useLayoutEffect(() => {
    keyState.current = { flat, current, query, busy, onBack, open };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const search = searchRef.current;
      if (typingElsewhere(event.target, search)) return;
      if (event.target instanceof Element && event.target.closest("[role=dialog]")) return;
      const state = keyState.current;
      const inSearch = event.target === search;
      const last = state.flat.length - 1;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "/" && !inSearch && !mod) {
        event.preventDefault();
        search?.focus();
      } else if (event.key === "ArrowDown" && !mod) {
        event.preventDefault();
        setSelected(Math.min(last, state.current + 1));
      } else if (event.key === "ArrowUp" && !mod) {
        event.preventDefault();
        setSelected(Math.max(0, state.current - 1));
      } else if (event.key === "Home" && !inSearch) {
        event.preventDefault();
        setSelected(0);
      } else if (event.key === "End" && !inSearch) {
        event.preventDefault();
        setSelected(Math.max(0, last));
      } else if (event.key === "Enter" && !event.altKey && !event.shiftKey) {
        const target = state.flat[state.current];
        if (!target) return;
        if (!inSearch && event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        state.open(target, mod);
      } else if (event.key === "Escape") {
        if (state.query) {
          event.preventDefault();
          setQuery("");
        } else if (state.onBack) {
          event.preventDefault();
          state.onBack();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const count = sessions.length;
  const activeDescendant = selectedSession ? rowId(current) : undefined;
  const indexOf = new Map(flat.map((s, i) => [s.id, i]));

  return (
    <div className="picker session-browser">
      <div className="picker-head" data-tauri-drag-region>
        {onBack ? <BackButton label={backLabel} onClick={onBack} /> : null}
        <span className="picker-title" title={title}>
          {title}
        </span>
        {!loading && (
          <span className="sb-count">{`${count} ${count === 1 ? noun.one : noun.many}`}</span>
        )}
        <span className="sb-search">
          <input
            ref={searchRef}
            className="sb-search-input"
            type="search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            aria-label={`Search ${noun.many}`}
            placeholder={`Search ${noun.many}\u2026`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd aria-hidden="true">/</kbd>
        </span>
        <span className="picker-head-actions">
          <button className="btn btn-primary btn-sm" disabled={busy || newDisabled} onClick={onNew}>
            {newLabel}
          </button>
          {headActions}
        </span>
      </div>

      <div className="sb-scroll">
        <div className="sb-column">
          {notices}
          {loading && <ListSkeleton rows={5} />}
          {!loading && count === 0 && empty}
          {!loading && chips.length > 0 && (
            <div className="sb-chips" role="group" aria-label={`Filter ${noun.many}`}>
              {[{ value: null, label: "All", count }, ...chips].map((chip) => (
                <button
                  key={chip.value ?? "all"}
                  type="button"
                  className="sb-chip"
                  aria-pressed={activeFilter === chip.value}
                  onClick={() => setFilter(chip.value)}
                >
                  {chip.label}
                  <span className="sb-chip-count">{chip.count}</span>
                </button>
              ))}
            </div>
          )}
          {!loading && count > 0 && flat.length === 0 && (
            <EmptyState message={`No ${noun.many} match \u201c${query.trim()}\u201d.`}>
              <button className="btn btn-ghost btn-sm" onClick={() => setQuery("")}>
                {"Clear search"}
              </button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={onNew}>
                {newLabel}
              </button>
            </EmptyState>
          )}
          {!loading && flat.length > 0 && (
            <div
              ref={listRef}
              id={listId}
              className="sb-list"
              role="listbox"
              aria-label={title}
              tabIndex={0}
              aria-activedescendant={activeDescendant}
              aria-busy={busy || undefined}
            >
              {groups.map((group) => (
                <div
                  key={group.key}
                  role="group"
                  aria-label={group.label ?? undefined}
                  className="sb-group"
                >
                  {group.label && (
                    <div className="sb-group-label" aria-hidden="true">
                      {group.label}
                    </div>
                  )}
                  {group.sessions.map((session) => {
                    const at = indexOf.get(session.id) ?? 0;
                    const isSel = at === current;
                    const preview = session.preview || "(no preview)";
                    const note = rowNote?.(session);
                    const style = sourceStyle(session.source ?? "ggcoder");
                    const time =
                      typeof session.lastActiveMs === "number"
                        ? formatSessionTime(session.lastActiveMs, now)
                        : session.lastActiveDisplay;
                    return (
                      <div
                        key={session.id}
                        id={rowId(at)}
                        role="option"
                        aria-selected={isSel}
                        aria-disabled={busy || undefined}
                        className={`sb-row${isSel ? " is-selected" : ""}`}
                        title={note ? `${preview}\n${note}` : preview}
                        onClick={() => {
                          setSelected(at);
                          open(session, false);
                        }}
                      >
                        <span className="sb-row-title">{preview}</span>
                        {isForeign(session) && (
                          <span className="sb-row-source">
                            <span
                              className="sb-dot"
                              style={{ background: style.color }}
                              aria-hidden="true"
                            />
                            {style.label}
                          </span>
                        )}
                        {isRunning(session) && (
                          <span className="sb-row-running">
                            <span className="sb-dot" aria-hidden="true" />
                            Running
                          </span>
                        )}
                        <span className="sb-row-actions">
                          <button
                            type="button"
                            tabIndex={-1}
                            className="sb-action"
                            disabled={busy}
                            aria-label={`Open ${preview}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              open(session, false);
                            }}
                          >
                            {"Open \u21b5"}
                          </button>
                          {onOpenInNewWindow && (
                            <button
                              type="button"
                              tabIndex={-1}
                              className="sb-action"
                              disabled={busy}
                              aria-label={`Open ${preview} in a new window`}
                              onClick={(e) => {
                                e.stopPropagation();
                                open(session, true);
                              }}
                            >
                              {"New window"}
                            </button>
                          )}
                        </span>
                        <span className="sb-row-count">{`${session.messageCount} msgs`}</span>
                        <span className="sb-row-time">{time}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {footer}
        </div>
      </div>

      <div className="sb-hint" aria-hidden="true">
        <span>
          <kbd>{"\u2191"}</kbd> <kbd>{"\u2193"}</kbd> move
        </span>
        <span>
          <kbd>{"\u21b5"}</kbd> open
        </span>
        {onOpenInNewWindow && (
          <span>
            <kbd>{`${mod} \u21b5`}</kbd> new window
          </span>
        )}
        <span>
          <kbd>/</kbd> search
        </span>
        {onBack && (
          <span>
            <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
