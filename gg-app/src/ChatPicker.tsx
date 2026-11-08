import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import {
  arrangeAllWindows,
  focusWindowByOffset,
  getSettings,
  listSessions,
  newWindow,
  selectWorkspace,
  waitForReady,
  type ChatAgentId,
  type RecentSession,
} from "./agent";
import { motionWorkspacePath } from "./motion-workspace";
import { SessionBrowser } from "./SessionBrowser";
import { useCachedList } from "./useCachedList";
import { RadioButton } from "./RadioButton";
import { WindowLayoutButton } from "./WindowLayoutButton";

interface Props {
  onChosen: (cwd: string) => void;
  onClose?: () => void;
  initialAgent?: ChatAgentId;
  /** Which non-coding workspace this picker opens. Defaults to chat. */
  mode?: "chat" | "motion";
}

const COPY = {
  chat: {
    title: "Chats",
    noun: { one: "chat", many: "chats" },
    newLabel: "+ New chat",
    empty: "No chats yet. Start one and it shows up here to pick up later.",
    noRoot: "Choose a projects folder in Settings before starting a chat.",
    loadError: "Chats could not be loaded.",
  },
  motion: {
    title: "Motion",
    noun: { one: "video", many: "videos" },
    newLabel: "+ New video",
    empty: "No videos yet. Start one and it shows up here to pick up later.",
    noRoot: "Choose a projects folder in Settings before starting a video.",
    loadError: "Motion sessions could not be loaded.",
  },
} as const;

/** Session chooser for Chat or Motion, rooted at the configured projects folder. */
export function ChatPicker({
  onChosen,
  onClose,
  initialAgent = "general",
  mode = "chat",
}: Props): React.ReactElement {
  const copy = COPY[mode];
  const [projectsRoot, setProjectsRoot] = useState("");
  const [busy, setBusy] = useState(false);
  // Where this mode's sessions live, from Settings. Read on its own (not as
  // part of the list load) so a kept list shown at once can still be opened.
  const rootFor = useCallback(async (): Promise<string> => {
    const settings = await getSettings();
    const projects = settings?.projectsRoot.trim() ?? "";
    if (!projects) throw new Error(copy.noRoot);
    return mode === "motion" ? motionWorkspacePath(projects) : projects;
  }, [copy, mode]);
  useEffect(() => {
    let cancelled = false;
    void rootFor()
      .then((root) => {
        if (!cancelled) setProjectsRoot(root);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rootFor]);
  // Shown at once on a return visit, refreshed quietly (see useCachedList).
  const sessionList = useCachedList<RecentSession>(`sessions:${mode}`, async () => {
    const root = await rootFor();
    await waitForReady();
    return listSessions(root, mode === "motion" ? "motion" : "all");
  });
  const { items: sessions, loading, error } = sessionList;
  // Opening a chat failed; shown above the list so the click isn't silent.
  const [chooseError, setChooseError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        void focusWindowByOffset(event.shiftKey ? -1 : 1);
      } else if (event.shiftKey && (event.key === "a" || event.key === "A") && !event.altKey) {
        event.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function choose(session?: RecentSession): void {
    if (busy || !projectsRoot) return;
    setBusy(true);
    setChooseError(null);
    void selectWorkspace(mode, projectsRoot, session?.path, session?.chatAgent ?? initialAgent)
      .then(() => onChosen(projectsRoot))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setChooseError(`Couldn't open that: ${message}`);
        setBusy(false);
      });
  }

  function openInNewWindow(session: RecentSession): void {
    if (busy || !projectsRoot) return;
    setChooseError(null);
    void newWindow({
      mode,
      chatAgent: session.chatAgent ?? initialAgent,
      cwd: projectsRoot,
      sessionPath: session.path,
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setChooseError(`Couldn't open that in a new window: ${message}`);
    });
  }

  return (
    <SessionBrowser
      title={copy.title}
      noun={copy.noun}
      sessions={error ? [] : sessions}
      loading={loading}
      busy={busy}
      newLabel={copy.newLabel}
      newDisabled={loading || !projectsRoot}
      onNew={() => choose()}
      onBack={onClose}
      onOpen={(session) => choose(session)}
      onOpenInNewWindow={openInNewWindow}
      filterBy="chatAgent"
      headActions={
        <>
          <RadioButton />
          <WindowLayoutButton />
        </>
      }
      notices={
        <>
          {chooseError && (
            <div className="picker-error" role="alert">
              {chooseError}
            </div>
          )}
          {!loading && error && (
            <div className="picker-empty" role="alert">
              <span style={{ color: theme.textMuted }}>{error}</span>
              {/* No projects folder is a settings problem, so retrying can't fix it. */}
              {error !== copy.noRoot && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={sessionList.reload}>
                  Try again
                </button>
              )}
            </div>
          )}
        </>
      }
      empty={
        error ? null : (
          <div className="picker-empty">
            <span style={{ color: theme.textMuted }}>{copy.empty}</span>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => choose()}>
              {copy.newLabel}
            </button>
          </div>
        )
      }
    />
  );
}
