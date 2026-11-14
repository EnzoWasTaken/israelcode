import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowElbowDownLeftIcon,
  CaretDownIcon,
  FolderSimpleIcon,
  type Icon,
} from "./phosphor-icons";
import {
  getSettings,
  importTranscript,
  listProjects,
  selectProject,
  selectWorkspace,
  waitForReady,
  type BackgroundSessionRow,
  type DiscoveredProject,
} from "./agent";
import { useCachedList } from "./useCachedList";
import { loadHomeRecents, recentTitle, type HomeRecent } from "./home-recents";
import { queueFirstPrompt } from "./first-prompt";
import { useProjectColour } from "./project-colours";
import { resolveProjectAccent } from "./projectAccent";
import {
  BackgroundSection,
  isActive,
  listableRows,
  projectName,
  relativeTime,
  useBackgroundSessions,
} from "./BackgroundSessions";
import { useNow } from "./useNow";
import { PixelTip } from "./PixelTip";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { fl } from "./flavor";
import { formatShortcut, type ShortcutId } from "./commands/command-registry";
import { openPalette, useCommandSurface } from "./commands/command-store";
import { isMacPlatform } from "./platform";
import { toast } from "./toast";

/** One button of the mode row. */
export interface HomeMode {
  id: "code" | "goals" | "chat" | "motion" | "world";
  label: string;
  icon: Icon;
  /** The existing plate tip, kept as the tooltip. */
  tip: string;
  shortcut: ShortcutId;
  onClick: () => void;
  dimmed?: boolean;
  busy?: boolean;
  /** A small tag over the button (World's "New"). */
  tag?: ReactNode;
  describedBy?: string;
}

type StartMode = "code" | "chat";

interface Props {
  /** Folder and provider are set up; otherwise actions say what's missing. */
  ready: boolean;
  /** Take the user to the missing prerequisite. */
  onNeedsSetup: () => void;
  /** The window now points at a session of this kind: show it. */
  onOpened: (mode: StartMode) => void;
  modes: readonly HomeMode[];
  onOpenBackground?: (row: BackgroundSessionRow) => Promise<void> | void;
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color"].includes(
      target.type,
    );
  }
  return false;
}

function message(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text
    .replace(/Run ["'`]?ggcoder login["'`]?/gi, "Use AI providers to sign in")
    .replace(/ggcoder login/gi, "AI providers");
}

function Kbd({ children }: { children: ReactNode }): ReactElement {
  return (
    <kbd className="home-kbd" aria-hidden="true">
      {children}
    </kbd>
  );
}

function ProjectDot({ cwd }: { cwd: string | undefined }): ReactElement {
  const { choice } = useProjectColour(cwd);
  const accent = cwd ? resolveProjectAccent(cwd, choice) : null;
  return (
    <span
      className="home-dot"
      aria-hidden="true"
      style={accent ? { background: accent } : undefined}
    />
  );
}

/**
 * Home's glass panel: quick start (a project, a first message, Code or Chat),
 * the latest sessions to jump back into, the mode row and a footer for
 * background work and the palette.
 */
export function HomeLaunchpad({
  ready,
  onNeedsSetup,
  onOpened,
  modes,
  onOpenBackground,
}: Props): ReactElement {
  const mac = isMacPlatform();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<StartMode>("code");
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [showBackground, setShowBackground] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const surface = useCommandSurface();
  const ids = { menu: useId(), list: useId(), heading: useId(), error: useId() };

  // Shares ProjectPicker's kept copy, so either screen fills the other at once.
  const projectList = useCachedList<DiscoveredProject>("projects", async () => {
    await waitForReady();
    return listProjects();
  });
  const recents = useCachedList<HomeRecent>("home-recents", () => loadHomeRecents());
  const rows = recents.items;
  const projects = projectList.items;
  const project: DiscoveredProject | null =
    (projectPath && projects.find((p) => p.path === projectPath)) ||
    (projectPath
      ? {
          name: projectName(projectPath),
          path: projectPath,
          lastActiveDisplay: "",
          sources: [],
        }
      : (projects[0] ?? null));

  const bgRows = useBackgroundSessions();
  const bgListed = listableRows(bgRows).length;
  const bgActive = bgRows.filter(isActive).length;
  const showBgFooter = ready && Boolean(onOpenBackground) && bgListed > 0;

  useEffect(() => {
    if (selected >= rows.length && rows.length > 0) setSelected(0);
  }, [rows.length, selected]);

  // Close the project menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!chipRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
        chipRef.current?.querySelector<HTMLElement>(".home-chip")?.focus();
      }
    };
    const items = chipRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']");
    const current = chipRef.current?.querySelector<HTMLElement>("[aria-checked='true']");
    (current ?? items?.[0])?.focus();
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  function onProjectMenuKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']"));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function fail(reason: unknown, prefix = "Couldn't open that"): void {
    setError(`${prefix}: ${message(reason)}`);
    setBusy(false);
  }

  async function start(): Promise<void> {
    if (busy) return;
    if (!ready) {
      onNeedsSetup();
      return;
    }
    const prompt = text.trim();
    setBusy(true);
    setError(null);
    try {
      if (mode === "code") {
        if (!project) {
          setError("Pick a project first, or open a folder.");
          setBusy(false);
          return;
        }
        await selectProject(project.path);
      } else {
        const settings = await getSettings();
        const root = settings?.projectsRoot.trim() ?? "";
        if (!root) throw new Error("choose a projects folder in Settings first.");
        await selectWorkspace("chat", root, undefined, "general");
      }
      // Sent by App once the new session is ready, through the composer.
      if (prompt) queueFirstPrompt(prompt);
      onOpened(mode);
    } catch (e) {
      fail(e, "Couldn't start that");
    }
  }

  async function resume(row: HomeRecent | undefined): Promise<void> {
    if (!row || busy) return;
    if (!ready) {
      onNeedsSetup();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (row.kind === "chat") {
        await selectWorkspace(
          "chat",
          row.cwd,
          row.session.path,
          row.session.chatAgent ?? "general",
        );
      } else {
        let path = row.session.path;
        // Claude Code / Codex rows import into a GG Coder session first, as ProjectPicker does.
        if (row.session.source === "claude-code" || row.session.source === "codex") {
          const imported = await importTranscript(path, row.cwd);
          if (!imported.ok) {
            fail(imported.error, "Could not import that conversation");
            return;
          }
          path = imported.sessionPath;
        }
        await selectProject(row.cwd, path);
      }
      onOpened(row.kind);
    } catch (e) {
      fail(e);
    }
  }

  function openFolder(): void {
    setMenuOpen(false);
    void openFolderDialog({ directory: true, multiple: false, title: "Open existing project" })
      .then((picked) => {
        if (typeof picked === "string") {
          setProjectPath(picked);
          setMode("code");
        }
      })
      .catch((e: unknown) => toast(`Couldn't open the folder picker: ${String(e)}`, "error"));
  }

  function move(delta: number): void {
    if (rows.length === 0) return;
    setSelected((i) => (i + delta + rows.length) % rows.length);
  }

  // Keys 1–5 pick a mode; Up/Down/Enter drive the recents. Only while focus is
  // outside text fields and no palette or sheet is open.
  const keyState = useRef({ modes, rows, selected, surface, resume, move });
  useLayoutEffect(() => {
    keyState.current = { modes, rows, selected, surface, resume, move };
  });
  // Times in the recents refresh every 30 s on an open Home.
  const now = useNow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = keyState.current;
      if (e.defaultPrevented || s.surface || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextField(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const n = Number(e.key);
      if (!e.shiftKey && Number.isInteger(n) && n >= 1 && n <= s.modes.length) {
        e.preventDefault();
        s.modes[n - 1]?.onClick();
        return;
      }
      // Arrows and Enter only from the page itself (a focused button keeps its own Enter).
      const onPage =
        e.target === document.body ||
        (e.target instanceof HTMLElement && e.target.classList.contains("home"));
      if (!onPage) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        s.move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && s.rows.length > 0) {
        e.preventDefault();
        void s.resume(s.rows[s.selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const placeholder = fl("What are we building?", "What are we building, habibi?");
  const activeId = rows.length > 0 ? `${ids.list}-${selected}` : undefined;

  return (
    <div className="home-panel" aria-busy={busy || undefined}>
      <form
        className="home-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        {mode === "code" && (
          <div className="home-chip-wrap" ref={chipRef}>
            <button
              type="button"
              className="home-chip"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? ids.menu : undefined}
              aria-label={`Project: ${project?.name ?? "none"}`}
              title={project?.path ?? "Choose a project"}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <ProjectDot cwd={project?.path} />
              <span className="home-chip-name">{project?.name ?? "Project"}</span>
              <CaretDownIcon size={12} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                id={ids.menu}
                className="home-menu"
                role="menu"
                aria-label="Projects"
                onKeyDown={onProjectMenuKey}
              >
                {projects.slice(0, 8).map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    role="menuitemradio"
                    aria-checked={p.path === project?.path}
                    className="home-menu-item"
                    title={p.path}
                    onClick={() => {
                      setProjectPath(p.path);
                      setMenuOpen(false);
                      inputRef.current?.focus();
                    }}
                  >
                    <ProjectDot cwd={p.path} />
                    <span className="home-menu-name">{p.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="home-menu-item home-menu-open"
                  onClick={openFolder}
                >
                  <FolderSimpleIcon size={14} aria-hidden="true" />
                  <span className="home-menu-name">{"Open folder\u2026"}</span>
                </button>
              </div>
            )}
          </div>
        )}
        <input
          ref={inputRef}
          className="home-prompt-input"
          type="text"
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-describedby={error ? ids.error : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && rows.length > 0) {
              e.preventDefault();
              listRef.current?.focus();
            }
          }}
        />
        <div className="home-seg" role="radiogroup" aria-label="Start in">
          {(["code", "chat"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className="home-seg-btn"
              onClick={() => setMode(m)}
            >
              {m === "code" ? "Code" : "Chat"}
            </button>
          ))}
        </div>
        <button
          type="submit"
          className="home-go"
          aria-label={mode === "code" ? "Start a new session" : "Start a new chat"}
          title={text.trim() ? "Start and send (Enter)" : "Start (Enter)"}
          disabled={busy}
        >
          <ArrowElbowDownLeftIcon size={16} weight="bold" aria-hidden="true" />
        </button>
      </form>
      {error && (
        <p id={ids.error} className="home-error" role="alert">
          {error}
        </p>
      )}

      <div className="home-section-head">
        <h2 id={ids.heading} className="home-section-title">
          Jump back in
        </h2>
        <button
          type="button"
          className="home-link-btn"
          aria-label="All sessions"
          title="Search all projects and sessions"
          onClick={() => openPalette(["Projects", "Sessions"])}
        >
          All sessions <Kbd>{formatShortcut("quickSwitch", mac)}</Kbd>
        </button>
      </div>
      {recents.loading ? (
        <div className="home-recents-skeleton" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="home-recent is-skeleton">
              <Skeleton width="55%" height={12} />
              <Skeleton width="18%" height={10} />
            </div>
          ))}
        </div>
      ) : recents.error ? (
        <EmptyState className="home-empty" message="Couldn't load your recent sessions.">
          <button type="button" className="home-link-btn" onClick={recents.reload}>
            Try again
          </button>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          className="home-empty"
          message={fl(
            "Nothing to jump back into yet. Type above and press Enter to start your first session.",
            "Nothing here yet, habibi. Type above and press Enter to start your first session.",
          )}
        />
      ) : (
        <div
          ref={listRef}
          className="home-recents"
          role="listbox"
          tabIndex={0}
          aria-labelledby={ids.heading}
          aria-activedescendant={activeId}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void resume(rows[selected]);
            }
          }}
        >
          {rows.map((row, i) => (
            <RecentRow
              key={row.session.path}
              id={`${ids.list}-${i}`}
              row={row}
              selected={i === selected}
              now={now}
              onPoint={() => setSelected(i)}
              onOpen={() => void resume(row)}
            />
          ))}
        </div>
      )}

      <div className="home-modes">
        {modes.map((m, i) => (
          <PixelTip key={m.id} text={m.tip}>
            <button
              type="button"
              className={`home-mode${m.dimmed ? " is-dimmed" : ""}${m.busy ? " is-loading" : ""}`}
              aria-label={m.label}
              aria-disabled={m.dimmed || undefined}
              aria-busy={m.busy || undefined}
              aria-describedby={m.describedBy}
              aria-keyshortcuts={String(i + 1)}
              onClick={m.onClick}
            >
              <span className="home-mode-icon" aria-hidden="true">
                <m.icon size={16} />
              </span>
              <span className="home-mode-label">{m.label}</span>
              <Kbd>{i + 1}</Kbd>
              {m.tag}
            </button>
          </PixelTip>
        ))}
      </div>

      <div className="home-foot">
        {showBgFooter ? (
          <span className="home-foot-bg">
            <i className="home-pulse" aria-hidden="true" />
            {bgActive > 0
              ? `${bgActive} working in the background`
              : `${bgListed} finished in the background`}
            {" \u00b7 "}
            <button
              type="button"
              className="home-link-btn"
              aria-expanded={showBackground}
              aria-label="View background sessions"
              onClick={() => setShowBackground((v) => !v)}
            >
              {showBackground ? "Hide" : "View"}
            </button>
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="home-link-btn home-foot-all"
          aria-label="Command palette"
          title="Search every command, project and session"
          onClick={() => openPalette()}
        >
          Command palette <Kbd>{formatShortcut("palette", mac)}</Kbd>
        </button>
      </div>
      {showBgFooter && showBackground && onOpenBackground && (
        <BackgroundSection onOpen={onOpenBackground} />
      )}
    </div>
  );
}

function RecentRow({
  id,
  row,
  selected,
  now,
  onPoint,
  onOpen,
}: {
  id: string;
  row: HomeRecent;
  selected: boolean;
  now: number;
  onPoint: () => void;
  onOpen: () => void;
}): ReactElement {
  const ms = row.session.lastActiveMs;
  const when = ms ? relativeTime(ms, now) : row.session.lastActiveDisplay;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`home-recent${selected ? " is-selected" : ""}`}
      onPointerEnter={onPoint}
      onClick={onOpen}
    >
      {row.kind === "code" ? (
        <ProjectDot cwd={row.cwd} />
      ) : (
        <span className="home-dot is-chat" aria-hidden="true" />
      )}
      <span className="home-recent-title">{recentTitle(row.session)}</span>
      <span className="home-recent-where">{row.where}</span>
      <span className="home-recent-when">{when}</span>
      <span className="home-recent-enter" aria-hidden="true">
        {selected ? "\u21b5" : ""}
      </span>
    </div>
  );
}
