import {
  Activity,
  Suspense,
  lazy,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type SetStateAction,
} from "react";
import { createChatLayoutMotion } from "./chat-layout-motion";
import { theme } from "./theme";
import { activeChatErrorId, readChatError } from "./chat-error";
import { showScreen } from "./view-transition";
import {
  waitForReady,
  getState,
  kickoffGoal,
  resumeGoal,
  sendPrompt,
  setAutopilot,
  cancel,
  newSession,
  selectProject,
  selectWorkspace,
  type BackgroundSessionRow,
  listModels,
  listCommands,
  cancelQueued,
  type RewindMode,
  type QueuedMessage,
  listHistory,
  listTasks,
  type ChecklistEntry,
  runTask,
  runAllTasks,
  deleteTask,
  restoreTarget,
  subscribe,
  isSecondaryWindow,
  windowLabel,
  type AgentState,
  type WorkspaceMode,
  type ModelOption,
  type SlashCommand,
  type BackgroundTask,
  type ProjectTask,
  type PromptSegment,
  answerAskUser,
} from "./agent";
import {
  answerAskItem,
  askItemFor,
  dropSupersededAsks,
  parseOpenAskPrompts,
  withOpenAsks,
} from "./ask-user";
import { glowPlacement, glowStateFor, glowVars } from "./window-glow";
import { ActivityBar } from "./ActivityBar";
import { createEntranceLifetime } from "./transcript-motion";
import { createLiveTextStore } from "./live-text";
import { KenActivityBar } from "./KenActivityBar";
import { useTaskActivity } from "./useTaskActivity";
import { useKenMentor } from "./useKenMentor";
import { useAutopilot } from "./useAutopilot";
import { useAgentEvents, type RunEnd } from "./useAgentEvents";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";
import { TodoPill } from "./TodoList";
import { ultracodePhases, ultracodeTurns, type UltracodePhase } from "./ultracode-phases";
import { ApprovalCard } from "./ApprovalCard";
import { currentPill } from "./permission-mode";
import { CritterFloor, type CritterGroup } from "./CritterFloor";
import { recordRun, type GoalRun } from "./goal-finish";
// The farm (its art, map and simulation) loads on demand, so it adds nothing
// to the app's start-up bundle; it is only needed once a goal has started.
const GoalWorld = lazy(() =>
  import("./GoalWorld").then((module) => ({ default: module.GoalWorld })),
);
import { loadModelsInto } from "./ModelSelect";
import { useSchedules } from "./useSchedules";
import { parseProjectHealth } from "./project-health";
import { MotionStarters } from "./MotionStarters";
import { ProjectPicker } from "./ProjectPicker";
import { type DraftEnhancement, followDraftEdit } from "./PromptEnhancement";
import { ChatPicker } from "./ChatPicker";
import { GoalPicker } from "./LazyGoalPicker";
import { BackButton } from "./BackButton";
import { noteBackgroundHandoff } from "./BackgroundSessions";
import {
  LazyGoalSettingsModal,
  LazyMemoryModal,
  LazyNotesModal,
  LazySettingsModal,
  LazyTasksModal,
  LazyChecklistScreen,
  LazyWorldScreen,
  deckSurfacesReady,
  preloadDeckSurfaces,
  preloadLazySurfaces,
} from "./lazy-surfaces";
import { whenIdle } from "./idle-preload";
import { initialEntryView, type EntryView } from "./app-entry-view";
import {
  showsQueuedBubble,
  submitDisposition,
  withoutSupersedingMessage,
} from "./submit-disposition";
import { Toaster } from "./Toaster";
import { Confetti } from "./Confetti";
import { ScorecardPanel } from "./Scorecard";
import { useWindowFocused } from "./useWindowFocused";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { useProgress } from "./useProgress";
import { useTrophies } from "./useTrophies";
import type { SettingsTabId } from "./settings-sections";
import { toast } from "./toast";
import { takeNewBlockedSkillMessages } from "./blocked-skills";
import { takeNewSecurityNotices } from "./security-notices";
import { nextId, lastIssuedId, type Item } from "./transcript-item";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useTrayIntents } from "./useTrayIntents";
import { useAttachments } from "./useAttachments";
import { useDragOverlay, useWindowFileDrop } from "./useFileDrop";
import { DeckMenu, TitleBarActions } from "./WorkspaceHeaderActions";
import { Deck, type DeckPanelId } from "./Deck";
import { ProjectHealthPanel } from "./ProjectHealthBadge";
import { useChecklist } from "./useChecklist";
import { useProjectNotes } from "./useProjectNotes";
import { useChromeToggles } from "./useChromeToggles";
import { useTranscriptExport } from "./useTranscriptExport";
import { useWindowOrder } from "./useWindowOrder";
import { Composer } from "./Composer";
import { UpdateBanner } from "./UpdateBanner";
import { usePromptHistory } from "./usePromptHistory";
import { usePromptEnhance } from "./usePromptEnhance";
import { useShellRuns } from "./useShellRuns";
import { isWorkflowCommand as isKnownWorkflowCommand } from "./composer-commands";
import { itemsFromHistory, promptHistoryFrom } from "./history-items";
import { createPlanReviewActions } from "./plan-review-actions";
import { createSessionActions } from "./session-actions";
import { useChatLayoutCommit } from "./useChatLayoutCommit";
import { useComposerAutosize } from "./useComposerAutosize";
import { useComposerMenus } from "./useComposerMenus";
import { useComposerPlaceholder } from "./useComposerPlaceholder";
import { useGoalWorld } from "./useGoalWorld";
import { useMonitorFit } from "./useMonitorFit";
import { useRankCelebration } from "./useRankCelebration";
import { useRunActivity } from "./useRunActivity";
import { useTranscriptViewport } from "./useTranscriptViewport";
import { useWindowShortcuts } from "./useWindowShortcuts";
import { useWindowTitle } from "./useWindowTitle";
import { EntryScreen } from "./EntryScreen";
import { TranscriptView } from "./TranscriptView";
import { WorkspaceModalHost } from "./WorkspaceModalHost";
import { CommandCenter, ShortcutHint } from "./commands/CommandCenter";
import { modelCommands, projectCommands, sessionCommands } from "./commands/dynamic-commands";
import type { CommandHandlers } from "./commands/command-registry";
import { setColorSchemePref } from "./color-scheme";
import {
  arrangeAllWindows,
  focusWindowByOffset,
  newWindow,
  openWhatsNewWindow,
  setPermissionMode,
  setThinkingLevel,
} from "./agent";
import { createComposerSubmit } from "./composer-submit";
import "./App.css";
import "./Deck.css";
import "./Trophies.css";

export type { Item, TranscriptImage } from "./transcript-item";

function App(): React.ReactElement {
  const [items, setItems] = useState<Item[]>([]);
  // Text of the reply streaming right now, grown outside `items` so each chunk
  // re-renders only that row (live-text.ts). One store for the window's life.
  const [liveText] = useState(createLiveTextStore);
  // Ken Kai (mentor agent): own running flag, token/thinking metrics, streaming
  // bubble, and `ken_*` SSE handling. Lives in its own hook; App just consumes
  // the state for rendering and delegates ken events to `handleKenEvent`.
  const { kenRunning, kenTokens, kenRunStartTs, handleKenEvent } = useKenMentor({
    setItems,
    nextId,
    liveText,
  });
  // Ken's face talks on the reply he is streaming right now: the last row,
  // while his run is live. Only that row's props change, so memo holds.
  const currentErrorId = useMemo(() => activeChatErrorId(items), [items]);
  const lastItem = items[items.length - 1];
  const talkingKenId = kenRunning && lastItem?.kind === "ken" ? lastItem.id : null;
  // Autopilot Ken (auto-reviewer): consumes the `autopilot_*` event family into
  // compact transcript markers + a "Ken reviewing…" flag. Separate hook, same
  // shared setItems/nextId pattern as useKenMentor.
  const { autopilotReviewing, handleAutopilotEvent } = useAutopilot({ setItems, nextId });
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const trophies = useTrophies();
  const [input, setInput] = useState("");
  // Shell-style prompt history for ↑/↓ recall in the chat input. Newest entries
  // last. `historyIndex` is null while editing a fresh draft; stepping ↑ walks
  // backwards into history, ↓ forwards. `historyDraftRef` stashes the in-progress
  // text so stepping ↓ past the newest entry restores what was being typed.
  const promptHistoryRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef("");
  const {
    attachments,
    setAttachments,
    attachmentsLoading,
    setAttachmentsLoading,
    attachmentReadsRef,
    attachmentGenerationRef,
    clearAttachments,
    stageAttachments,
    isFileDragOver,
    setIsFileDragOver,
    fileInputRef,
    addFiles,
    removeAttachment,
  } = useAttachments();
  // The most recent prompt-enhancement result. `plain` is the text now in the
  // textarea; `segments` drive the highlighted terms in the sent bubble. Edits
  // re-anchor the segments onto the new text (followDraftEdit), keeping every
  // corrected term the edit didn't touch. `enhancing` shows the pulse on the
  // Enhance pill mid-call.
  const [enhancement, setEnhancement] = useState<DraftEnhancement | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // Composer sends so far: a change tells the composer strips (attachments,
  // @-files, cold-cache notice) to drop what the send cleared in that commit.
  const [sendCount, setSendCount] = useState(0);
  // The floating "Enhance" pill is shown only after the user pauses typing for
  // ~1s (and hidden again on the next keystroke / send / empty input).
  const [enhanceHintVisible, setEnhanceHintVisible] = useState(false);
  // Drives the Matrix dissolve→decode animation over the input while enhancing.
  // `newText` is null until the enhancer returns (dissolve/scramble), then the
  // enhanced text (decode). Null when no animation is playing.
  const [enhanceAnim, setEnhanceAnim] = useState<{
    oldText: string;
    newText: string | null;
  } | null>(null);
  // Holds the resolved enhancement so the animation's onDone can apply it once
  // the decode settles (rather than popping the text in mid-animation).
  const pendingEnhanceRef = useRef<{ enhanced: string; segments: PromptSegment[] } | null>(null);
  // Number of messages queued mid-run (injected as steering by the sidecar).
  const [queuedCount, setQueuedCount] = useState(0);
  // Pending queued messages, so each can be cancelled individually. Kept
  // alongside the count because the sidecar is the source of truth for both.
  const [queuedMessages, updateQueuedMessages] = useState<QueuedMessage[]>([]);
  const [state, setState] = useState<AgentState | null>(null);
  // Transient "KEN IS ON"/"KEN IS OFF" takeover banner shown when Autopilot
  // is toggled. Null = not showing; the banner clears itself via `onDone`
  // once its slide-out animation finishes.
  const [kenPowerBanner, setKenPowerBanner] = useState<"on" | "off" | null>(null);
  const [running, setRunning] = useState(false);
  // Rewind picker: closed (null), or open preselecting a message's text ("" = newest).
  const [rewindAt, setRewindAt] = useState<string | null>(null);
  // Last composer keystroke (0 = none since this chat opened). The first
  // keystroke after opening or a >4 min idle pause prewarms the prompt cache.
  const lastKeystrokeAtRef = useRef(0);
  // Whether a run has completed in this window. Drives the ambient glow's
  // "done" state, which PERSISTS until the next run starts — the window really
  // is finished until you ask for something else (see window-glow.ts).
  const [hasFinishedRun, setHasFinishedRun] = useState(false);

  // Stable per window: seeded off the label, so a tiled grid never shows the
  // same glow twice, and a given window keeps its placement across reloads.
  const glowStyle = useMemo(() => glowVars(glowPlacement(windowLabel)), []);
  const glowState = glowStateFor(running, hasFinishedRun);

  // Watching the `running` flag keeps this in one place rather than threaded
  // through every path that can end a run (finish, cancel, error). No timers:
  // the state is durable, so there is nothing to retire.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setHasFinishedRun(false);
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    setHasFinishedRun(true);
  }, [running]);
  const cancelling = state?.runState === "cancelling";
  const requestCancel = useCallback(() => {
    if (cancelling) return;
    void cancel().catch(() => {
      // Native/sidecar transport failures may prevent the SSE cancel_failed
      // frame; restore the owned-running affordance so retry remains possible.
      setState((previous) =>
        previous ? { ...previous, running: true, runState: "running" } : previous,
      );
      setRunning(true);
      setStatus("cancellation failed; agent still running");
    });
  }, [cancelling]);
  const [status, setStatus] = useState("connecting to agent\u2026");
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const chatLayout = useMemo(
    () =>
      createChatLayoutMotion(() => ({
        transcript: scrollRef.current,
        surfaces: [liveRegionRef.current, composerRef.current],
      })),
    [],
  );
  const [liveToolFeed, updateLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const setLiveToolFeed = useCallback(
    (update: Parameters<typeof updateLiveToolFeed>[0]) => {
      chatLayout.capture();
      updateLiveToolFeed(update);
    },
    [chatLayout],
  );
  const setQueuedMessages = useCallback(
    (update: Parameters<typeof updateQueuedMessages>[0]) => {
      chatLayout.capture();
      updateQueuedMessages(update);
    },
    [chatLayout],
  );
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  // Pending plan awaiting review (the markdown). Non-null opens the review modal.
  const [planReview, setPlanReview] = useState<string | null>(null);
  // Bumped to remount the plan-review box (fresh, undecided) after a refused
  // Accept so the user can decide again.
  const [planReviewAttempt, setPlanReviewAttempt] = useState(0);
  // Path of the plan awaiting review, captured from `plan_exit`. Needed on accept
  // to bake the plan's `## Steps` into the agent's system prompt so it emits
  // `[DONE:n]` progress markers (drives the activity bar's Plan Steps widget).
  const planReviewPathRef = useRef<string | null>(null);
  // Approved-plan progress for the activity bar: total steps + completed set.
  const [planTotal, setPlanTotal] = useState(0);
  const [planDone, setPlanDone] = useState<Set<number>>(new Set());
  // Refs mirror the plan progress state for the memoized SSE event handler,
  // which intentionally does not re-capture React state on every render.
  const planTotalRef = useRef(0);
  const planDoneRef = useRef<Set<number>>(new Set());
  // Approval-time count kept only as a compatibility fallback for an older
  // sidecar whose session_reset has no canonical live-file total.
  const pendingPlanTotalRef = useRef<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  // The background model load gave up (every retry failed). The footer
  // pickers say so instead of claiming they are still connecting.
  const [modelsFailed, setModelsFailed] = useState(false);
  // Hydration couldn't reach the agent. Shown in place of the endless
  // "connecting to agent…" line, with a way to try again.
  const [connectError, setConnectError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // `/schedule` runtime. Fires each due prompt through the normal send path,
  // skipping any occurrence that comes due mid-run rather than stacking agents.
  // In-memory for the life of the window — see useSchedules.
  const { schedules, addSchedule, stopSchedule } = useSchedules({
    queuedPrompts: useMemo(() => queuedMessages.map((m) => m.text), [queuedMessages]),
    onFire: useCallback((prompt: string) => {
      // keepInput: the user did not press Enter for this — leave whatever they
      // are typing untouched.
      submitTextRef.current(prompt, undefined, { keepInput: true, scheduled: true });
    }, []),
  });
  // Files referenced via `@`, tracked as chips (NOT left in the input text).
  // Their paths are appended to the prompt on submit.
  const [mentionedPaths, setMentionedPaths] = useState<string[]>([]);
  // Footer extras mirrored from the sidecar: live background tasks and the
  // running context-window usage (input-side tokens of the latest turn).
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  // Project task list (the agent's `tasks` tool store), shown in the deck.
  // Updated live via the `tasks_list` SSE event while a run-all sweep advances.
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([]);
  // What has taken the message box's place in the deck, if anything.
  const [deckPanel, setDeckPanelNow] = useState<DeckPanelId | null>(null);
  // Deck tool bodies load on demand: every change waits (in order) until
  // they're in, so a panel never opens around a suspended body.
  const setDeckPanel = useCallback((next: SetStateAction<DeckPanelId | null>) => {
    if (deckSurfacesReady()) setDeckPanelNow(next);
    else void preloadDeckSurfaces().then(() => setDeckPanelNow(next));
  }, []);
  useEffect(() => whenIdle(() => void preloadLazySurfaces()), []);
  // The checklist is a deck tool like Notes: open while the deck shows it.
  const showChecklist = deckPanel === "checklist";
  const setShowChecklist = useCallback(
    (next: SetStateAction<boolean>) => {
      setDeckPanel((open) => {
        const isOpen = open === "checklist";
        const want = typeof next === "function" ? next(isOpen) : next;
        if (want) return "checklist";
        return isOpen ? null : open;
      });
    },
    [setDeckPanel],
  );
  // The chat never leaves the screen for the checklist any more.
  const chatView = useMemo(() => ({ visible: true }), []);
  // Every window chooses a code or chat workspace before connecting. Mode stays
  // separate from picker visibility so restore and reopened pickers are explicit.
  const [needsProject, setNeedsProject] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("code");
  const rawProjectHealth = state?.projectHealth;
  const projectHealth = useMemo(
    () => (workspaceMode === "code" ? parseProjectHealth(rawProjectHealth) : null),
    [workspaceMode, rawProjectHealth],
  );
  // False until the boot-time workspace-restore check resolves.
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Every window starts from the mode-neutral home screen before choosing Code or Chat.
  const [entryView, setEntryView] = useState<EntryView>(initialEntryView(isSecondaryWindow));
  // World has faded in over Home (Home holds its World plate down until then).
  const [worldShown, setWorldShown] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general");
  // Re-open the matching session picker over an already-open workspace.
  const [showPicker, setShowPicker] = useState(false);
  // World over whatever this window shows (Home, a picker or a workspace); Back returns to it. ONE World layer for
  // every screen (see worldLayer below), so switching screens under it (the in-game computer opening a project)
  // never reloads the game.
  const [showWorld, setShowWorld] = useState(false);
  // The in-game computer: this window's own GG Coder over World (WorldScreen.tsx).
  const [worldComputer, setWorldComputer] = useState(false);
  // In the computer the app keeps its full-window layout and is scaled into the space between World's top bar and
  // Stand up (.app-in-monitor reads --mon-tf).
  const monitorOpen = showWorld && worldComputer;
  useMonitorFit(monitorOpen);
  // Bumped on each workspace/session choice to force re-hydration.
  const [hydrateNonce, setHydrateNonce] = useState(0);
  const { activity, handleActivityEvent } = useTaskActivity(hydrateNonce);
  // New-session confirmation modal + in-flight guard.
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  const { toolsHidden, setToolsHiddenPersisted, toggleTools } = useChromeToggles(chatLayout);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const { exporting, exportTranscript } = useTranscriptExport();
  const {
    appUpdate,
    showTraySettings,
    homeRefreshSignal,
    setHomeRefreshSignal,
    closeTraySettings,
  } = useTrayIntents({ needsProject, setWorkspaceMode, setEntryView, setShowPicker });
  // Initialize-git modal (shown via the top-right button when not yet a repo).
  const [showInitGit, setShowInitGit] = useState(false);
  // True once the initial hydrate (state + models + commands + history) has
  // settled for the current project/session. Gates the footer + chrome so they
  // reveal fully-formed in one pass instead of popping in piecemeal (cwd, git,
  // thinking, model each arriving separately would reflow the bar mid-load).
  const [hydrated, setHydrated] = useState(false);
  // First transcript id that should animate in. Everything restored by a
  // hydrate gets a lower id, so reopening a session (or switching projects)
  // lands instantly and only rows that arrive live afterwards rise into place.
  // Infinity while hydrating: nothing animates until the history is settled.
  const [liveFromId, setLiveFromId] = useState(Number.POSITIVE_INFINITY);
  const entrances = useMemo(() => createEntranceLifetime(liveFromId), [liveFromId]);
  // Children consume before playback. This parent effect also settles messages
  // received while Activity is hidden, when their own effects cannot run.
  useLayoutEffect(() => {
    const last = items[items.length - 1];
    if (last) entrances.settle(last.id);
  }, [entrances, items]);

  const readyRef = useRef(false);
  // Bumped by every hydrate. Lets work that outlives a hydrate (a project
  // switch, or re-selecting a session) tell whether its result is still wanted.
  const hydrateGenerationRef = useRef(0);
  // Mirror of `state` for use inside the memoized event handler (which doesn't
  // re-capture state). Lets turn_end pick the right context-token formula by
  // provider without re-subscribing the SSE listener on every state change.
  const stateRef = useRef<AgentState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Bumped each time the transcript is reloaded from the session file.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  // NOTE: the build-session event machine's private refs (streaming bubble id,
  // rAF buffer, per-run accumulators, sub-agent / compaction group ids) now live
  // inside the useAgentEvents hook. Only the cross-cutting refs that App's render
  // + other handlers also touch (stateRef above, the plan refs + stickToBottom
  // below) stay here and are passed into the hook.

  const transcriptScroll = useTranscriptScroll({ items, scrollRef, chatLayout });
  const {
    stickToBottomRef,
    lastScrollTopRef,
    noteTranscriptViewport,
    scrollToBottom,
    maybeScrollToBottom,
    windowStart,
    windowRef,
    startWarmMount,
  } = transcriptScroll;

  const setDragOverActive = useDragOverlay({ isFileDragOver, setIsFileDragOver });

  const insertDroppedFolderPaths = useCallback((paths: string[]): void => {
    if (paths.length === 0) return;
    const text = paths.join(" ");
    const append = (prev: string): string => {
      if (!prev.trim()) return text;
      return `${prev}${/\s$/.test(prev) ? "" : " "}${text}`;
    };
    setInput(append);
    // A live enhancement's `plain` is the current draft, so the same append
    // re-anchors its highlights; a stale one is discarded on the next edit/send.
    setEnhancement((current) =>
      current ? followDraftEdit(current, current.plain, append(current.plain)) : null,
    );
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const { xpChips, confettiNonce } = useRankCelebration({
    progress,
    levelUp,
    levelUpNonce,
    levelUpOrigin,
  });

  // Pinned-transcript upkeep: the pre-paint re-pin, the viewport and dock
  // observers (--dock-h) and the post-hydrate settle (useTranscriptViewport.ts).
  const { attachTranscript, transcriptFrameRef, dockElRef, dockRef } = useTranscriptViewport({
    items,
    windowStart,
    liveToolFeed,
    running,
    doneStatus,
    queuedCount,
    hydrated,
    hydrateNonce,
    scrollRef,
    chatLayout,
    lastScrollTopRef,
    noteTranscriptViewport,
    maybeScrollToBottom,
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const windowFocused = useWindowFocused();
  const sendDisabled =
    attachmentsLoading ||
    (!input.trim() && attachments.length === 0 && mentionedPaths.length === 0);
  // Cosmetic work only belongs to a focused, visible, empty code composer.
  const animatePlaceholder =
    windowFocused &&
    !needsProject &&
    !showPicker &&
    deckPanel === null &&
    workspaceMode === "code" &&
    input.length === 0;
  const displayPlaceholder = useComposerPlaceholder(animatePlaceholder, running);

  const { handleWindowDragEnter, handleWindowDragOver, handleWindowDragLeave, handleWindowDrop } =
    useWindowFileDrop({
      setDragOverActive,
      stageAttachments,
      attachmentGenerationRef,
      insertDroppedFolderPaths,
      addFiles,
    });

  useWindowTitle({ needsProject, showPicker, state, workspaceMode });

  // Auto-grow the chat textarea before paint (useComposerAutosize.ts).
  const { attachInput } = useComposerAutosize({
    chatLayout,
    inputRef,
    scrollRef,
    stickToBottomRef,
    input,
    enhanceAnim,
  });

  // History anchoring and autosizing have landed: commit the send/tool layout
  // transaction before paint (useChatLayoutCommit.ts).
  useChatLayoutCommit({
    chatLayout,
    needsProject,
    scrollRef,
    stickToBottomRef,
    lastScrollTopRef,
    scrollToBottom,
    hydrateNonce,
  });

  // Cmd/Ctrl+N, Cmd/Ctrl+`, Cmd/Ctrl+Shift+A (useWindowShortcuts.ts).
  useWindowShortcuts();

  const { windowIndex, windowTotal } = useWindowOrder(inputRef);

  // A goal cut off by a daemon restart (found on reconnect) carries on, or
  // asks its briefing question again. The sidecar ignores it when nothing was
  // cut off or a run is already going.
  const resumeCutOffGoal = useCallback(() => {
    void resumeGoal().catch((e: unknown) =>
      toast(
        `Couldn't pick the goal back up: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      ),
    );
  }, []);

  // Every run of a started goal, for its finish card (see goal-finish). The
  // event hook reports each run as it ends; only a started goal's are kept.
  const [goalRuns, setGoalRuns] = useState<readonly GoalRun[]>([]);
  const goalRunTargetRef = useRef<string | null>(null);
  const recordGoalRun = useCallback((run: RunEnd) => {
    const goalId = goalRunTargetRef.current;
    if (goalId) setGoalRuns((runs) => recordRun(runs, { ...run, goalId }));
  }, []);

  // Build-session SSE handling + assistant-streaming helpers live in the
  // useAgentEvents hook (mirrors useKenMentor). It owns the event machine's
  // private refs + the streaming helpers; App keeps owning the build-session
  // state (its render + other handlers use it) and passes the setters +
  // cross-cutting refs in. App consumes `handleEvent` (for the SSE subscription)
  // and the two helpers it still calls directly (`pushItem`, `endStreamingText`).
  const focusComposer = useCallback(() => inputRef.current?.focus(), []);
  const shellRuns = useShellRuns({ setItems, nextId, liveText, focusComposer, toast });
  const {
    shellTrusted,
    refreshShellTrust,
    revokeShellTrust,
    submitShell,
    markShellShared,
    handleShellEvent,
  } = shellRuns;
  const shellActions = useMemo(
    () => ({ confirm: shellRuns.confirm, stop: shellRuns.stop }),
    [shellRuns.confirm, shellRuns.stop],
  );
  const { handleEvent, pushItem, endStreamingText } = useAgentEvents({
    setItems,
    nextId,
    handleKenEvent,
    handleAutopilotEvent,
    handleShellEvent,
    handleActivityEvent,
    setState,
    setTasks,
    setProjectTasks,
    setStatus,
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens,
    setDoneStatus,
    setIsThinking,
    setThinkingStartTs,
    setThinkingAccumMs,
    setPlanTotal,
    setPlanDone,
    setPlanReview,
    setQueuedCount,
    setQueuedMessages,
    setAttachments: clearAttachments,
    setCommands,
    setModels,
    stateRef,
    planDoneRef,
    planTotalRef,
    planReviewPathRef,
    pendingPlanTotalRef,
    stickToBottomRef,
    liveText,
    onGoalNeedsResume: resumeCutOffGoal,
    onRunEnd: recordGoalRun,
  });

  // Run the connect/ready flow against the current sidecar and hydrate state,
  // models, and commands. Re-invoked after a project switch respawns the
  // sidecar (its port changes, so we re-wait for readiness).
  const hydrate = useCallback(async (): Promise<void> => {
    const generation = ++hydrateGenerationRef.current;
    readyRef.current = false;
    setHydrated(false);
    setLiveFromId(Number.POSITIVE_INFINITY);
    setStatus("connecting to agent\u2026");
    setConnectError(null);
    setModelsFailed(false);
    try {
      await waitForReady();
      readyRef.current = true;
      const st = await getState().catch(() => null);
      if (st) {
        setState(st);
        for (const message of takeNewBlockedSkillMessages(st.blockedSkills, localStorage)) {
          toast(message, "warning", 8000);
        }
        for (const message of takeNewSecurityNotices(st.installedThreats, localStorage)) {
          toast(message, "warning", 12000);
        }
        setRunning(st.running);
        setStatus(st.runState === "cancelling" ? "cancelling..." : "ready");
      } else {
        setConnectError("Couldn't read this session from the agent.");
      }
      // Retries: this is the only unprompted model load, and an empty list
      // disables the picker for the whole session (see loadModelsWithRetry).
      // Deliberately NOT awaited — nothing below needs the list, and blocking on
      // the backoff would hold the transcript behind up to ~4s of retries on
      // exactly the slow-booting machines the retry exists for. The picker
      // fills itself in when an answer arrives, unless this hydrate has since
      // been superseded (project switch) — then the old sidecar's answer is
      // dropped rather than overwriting the new project's picker.
      void loadModelsInto(
        listModels,
        setModels,
        () => hydrateGenerationRef.current !== generation,
      ).then((ok) => {
        if (!ok && hydrateGenerationRef.current === generation) setModelsFailed(true);
      });
      // Ask for the commands, tasks and history together: each is a sidecar
      // round trip, and a long chat's history is the slow one. Awaited in the
      // same order as before, so state lands the same way.
      const commandsCall = listCommands();
      const tasksCall = listTasks();
      const historyCall = listHistory();
      for (const call of [commandsCall, tasksCall]) call.catch(() => undefined);
      const cmds = await commandsCall;
      if (cmds.length > 0) setCommands(cmds);
      // Project task list for the Tasks modal + nav button.
      setProjectTasks(await tasksCall);
      // Hydrate the transcript when resuming an existing session — the webview
      // only sees live SSE events, so past messages must be fetched explicitly.
      const history = await historyCall;
      const pendingShellRuns = Array.isArray(st?.pendingShellRuns) ? st.pendingShellRuns : [];
      void refreshShellTrust();
      if (history.length > 0) {
        // A freshly hydrated session lands at the bottom (newest message).
        stickToBottomRef.current = true;
        // Seed ↑/↓ recall from the resumed prompts (chronological), so history
        // works after reopening a session — not just within the live one. App-
        // button prompts (shimmer labels) weren't typed by the user, so skip
        // them; everything else the user actually entered is included.
        promptHistoryRef.current = promptHistoryFrom(history);
        // A reloaded transcript gives every worker a new row key; the goal
        // header's tally starts again from it (see tallySource).
        setTranscriptEpoch((epoch) => epoch + 1);
        // Newest turns first; older rows of the page mount over the next frames.
        startWarmMount();
        setItems(itemsFromHistory(history, pendingShellRuns));
      }
      // History keeps a question's tool call but not its card: put back the
      // ones the agent is still waiting on.
      const openAsks = parseOpenAskPrompts(st?.openAskPrompts);
      if (openAsks.length > 0 && hydrateGenerationRef.current === generation) {
        setItems((prev) => withOpenAsks(prev, openAsks, (ask) => askItemFor(ask, nextId())));
      }
      // A goal's coordinator speaks first: the sidecar starts its reply once,
      // the first time the new goal is opened, and streams it like any turn.
      if (st?.goal?.needsKickoff && hydrateGenerationRef.current === generation) {
        void kickoffGoal().catch((e: unknown) =>
          toast(
            `Couldn't start the goal's first reply: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          ),
        );
      }
      // A goal cut off mid-work (the app closed while it worked) carries on
      // by itself when its window opens again.
      if (st?.goal?.needsResume && hydrateGenerationRef.current === generation) {
        void resumeGoal().catch((e: unknown) =>
          toast(
            `Couldn't pick the goal back up: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          ),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`agent failed to start: ${message}`);
      setConnectError(message);
    } finally {
      // Reveal the footer + chrome now that everything we know about the
      // session is in hand — one fade-in, no staggered reflow.
      setLiveFromId(lastIssuedId() + 1);
      setHydrated(true);
    }
  }, [stickToBottomRef, refreshShellTrust, startWarmMount]);

  useEffect(() => {
    const unsub = subscribe(handleEvent);
    return () => unsub();
  }, [handleEvent]);

  // Re-read the slash commands: each workspace root brings its own
  // `.gg/commands` (a goal's attached repos, `/add-dir`). An answer from a
  // superseded hydrate (project switch) is dropped.
  const refreshCommands = useCallback((): void => {
    const generation = hydrateGenerationRef.current;
    void listCommands().then((cmds) => {
      if (hydrateGenerationRef.current === generation && cmds.length > 0) setCommands(cmds);
    });
  }, []);
  // Roots added or removed mid-session (they arrive with the footer extras).
  const rootsKey = (state?.additionalRoots ?? []).join("\n");
  const rootsSeenRef = useRef(rootsKey);
  useEffect(() => {
    if (!hydrated || rootsSeenRef.current === rootsKey) return;
    rootsSeenRef.current = rootsKey;
    refreshCommands();
  }, [hydrated, rootsKey, refreshCommands]);

  // Boot-time/reload workspace recovery: Rust keeps THIS window's active target
  // for its lifetime. A restored app launch and a WebKit content-process reload
  // therefore both hydrate straight back into the existing daemon session.
  useEffect(() => {
    void restoreTarget()
      .then((target) => {
        if (target) {
          setWorkspaceMode(target.mode);
          // No crossfade on boot: there's no previous screen to fade from.
          resetForChosenProject();
        }
      })
      .finally(() => setRestoreChecked(true));
    // Mount-only: the native target remains stable for this window's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Only the main window auto-connects to its default project. Secondary
    // (project-*) windows show the picker first and connect on selection.
    // hydrateNonce forces a re-run when re-selecting a session in an already-
    // connected window (needsProject stays false there).
    if (!needsProject) void hydrate();
  }, [needsProject, hydrate, hydrateNonce]);

  // Open Tasks in the deck, refreshing the list from the sidecar first so it
  // reflects any tasks the agent just added.
  const openTasks = useCallback(() => {
    setDeckPanel("todo");
    void listTasks().then(setProjectTasks);
  }, [setDeckPanel]);
  const closeDeckPanel = useCallback(
    (id: DeckPanelId) => setDeckPanel((open) => (open === id ? null : open)),
    [setDeckPanel],
  );

  const {
    checklistLoad,
    setChecklistLoad,
    checklistRunId,
    setChecklistRunId,
    checklistNotice,
    setChecklistNotice,
    checklistRunRef,
    checklistFetchRef,
    openChecklist,
    refreshChecklist,
  } = useChecklist({ showChecklist, setShowChecklist, inputRef });

  // Run a single task: the sidecar opens a fresh session and streams progress
  // back (session_reset → task_start → run_start/…/run_end). Close the list so
  // the transcript is visible while it runs.
  const handleRunTask = useCallback(
    (id: string) => {
      closeDeckPanel("todo");
      void runTask(id);
    },
    [closeDeckPanel],
  );

  // Run every pending task sequentially (a fresh session each), in order.
  const handleRunAllTasks = useCallback(() => {
    closeDeckPanel("todo");
    void runAllTasks();
  }, [closeDeckPanel]);

  const handleDeleteTask = useCallback((id: string) => {
    void deleteTask(id).then(setProjectTasks);
  }, []);

  const { notes, handleNotesChange } = useProjectNotes(state?.cwd);

  // Model switching, permission mode, approvals and the session toggles
  // (session-actions.ts).
  const {
    onSelectKenModel,
    onSelectCritterModel,
    onSelectModel,
    onSelectWorkerModel,
    cyclePermission,
    answerApproval,
    changeUltracode,
    changeOrchestrate,
    changeVerify,
    changeWorktreeWorkers,
    changeCompaction,
  } = createSessionActions({ state, setState, running });

  // Context-window usage percentage for the footer meter. 0 (hidden) until we
  // have both a window size and a real token reading from a completed turn.
  const contextPct =
    state?.contextWindow && contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / state.contextWindow) * 100))
      : 0;

  // The draft's menus and keywords: slash commands, /schedule, @-files, !
  // commands, @Israel, Ultracode and Orchestrate (useComposerMenus.ts).
  const {
    caret,
    setCaret,
    setSlashIndex,
    mention,
    setMention,
    fileMatches,
    setFileIndex,
    scheduleDraft,
    scheduleInvalid,
    ultracodeAvailable,
    slashMatches,
    slashOpen,
    clampedSlashIndex,
    kenActive,
    kenInputParts,
    shellMode,
    ultracodeArmed,
    orchestrateKeyword,
    setUltracodeDismissed,
    shellMenu,
    mentionOpen,
    clampedFileIndex,
    fillComposer,
    fillScheduleInterval,
    pickSlashCommand,
    updateMention,
    pickMentionFile,
    removeMentionChip,
  } = useComposerMenus({
    input,
    setInput,
    setEnhancement,
    setMentionedPaths,
    inputRef,
    workspaceMode,
    state,
    commands,
    shellTrusted,
    revokeShellTrust,
    submitText,
  });

  const rewindAvailable = workspaceMode === "code" && !state?.goal;
  function finishRewind(result: { mode: RewindMode; prompt: string; filesRestored: number }): void {
    setRewindAt(null);
    const files = `${result.filesRestored} file${result.filesRestored === 1 ? "" : "s"} restored`;
    if (result.mode === "code") {
      toast(`Rewound the code: ${files}.`, "info");
      return;
    }
    // The conversation moved back: reload it, and put the prompt back to edit.
    resetForChosenProject();
    setInput(result.prompt);
    toast(result.mode === "both" ? `Rewound: ${files}.` : "Rewound the conversation.", "info");
  }

  // True when `text` is a known workflow command invocation (first token).
  function isWorkflowCommand(text: string): boolean {
    return isKnownWorkflowCommand(text, commands);
  }

  // Top-right commit affordance. `/commit` is built in (it runs the project's
  // checks, reviews, commits and pushes), so every project gets it; the
  // `/setup-commit` fallback only covers an older sidecar that lacks it.
  const hasCommit = commands.some((c) => c.name === "commit");
  const hasSetupCommit = commands.some((c) => c.name === "setup-commit");
  const commitCommand = hasCommit ? "commit" : hasSetupCommit ? "setup-commit" : null;
  // Until the project is a git repo, setting up commits is pointless — offer
  // "Initialize Git" first (modal collects visibility + repo name, then drives
  // the agent). isGitRepo can be undefined on older sidecars / before hydrate;
  // only treat an explicit `false` as "not a repo".
  const needsGitInit = state?.isGitRepo === false;
  // Default repo name = the project folder name.
  const defaultRepoName = (state?.cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

  /** Ordered queue events own both pending rows and cancelled transcript bubbles. */
  function handleCancelQueued(id: string): void {
    void cancelQueued(id);
  }

  // Submit arbitrary text as if typed + entered. Shared by the input, the
  // top-right commit button, and the workspace directory picker. `label` shows
  // a friendly shimmer phrase in the transcript while the full `text` is still
  // sent to the agent.
  //
  // `keepInput` is for sends the user did not initiate right now — a scheduled
  // prompt firing on its interval. Those must NOT clear the composer, or a
  // schedule that comes due mid-sentence deletes what the user was typing.
  function submitText(
    text: string,
    label?: string,
    opts?: { keepInput?: boolean; scheduled?: boolean; onError?: (error: unknown) => void },
  ): boolean {
    const trimmed = text.trim();
    // Mid-run this QUEUES as steering, exactly like a typed message (see
    // submit()): the sidecar injects it into the running loop. Dropping it
    // instead would be silent — the folder picker especially, which gives no
    // hint that the directory you just chose went nowhere.
    const disposition = submitDisposition(trimmed, readyRef.current, running);
    if (disposition === "ignore") return false;
    chatLayout.capture();
    markShellShared();
    // A send that supersedes an open question is consumed the moment it lands
    // (the sidecar releases the parked call), so it must not wear the queued
    // look for the one frame before that, nor open the queued strip below the
    // transcript — see showsQueuedBubble / withoutSupersedingMessage.
    const supersedesQuestion = hasOpenAsk();
    const queued = showsQueuedBubble(disposition, supersedesQuestion);
    if (disposition === "queue" && supersedesQuestion) noteSupersedingSend(trimmed);
    dismissOpenAsks();
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: label !== undefined || isWorkflowCommand(trimmed),
      ...(label !== undefined ? { label } : {}),
      ...(queued ? { queued: true } : {}),
    });
    if (!opts?.keepInput) {
      setInput("");
      setSlashIndex(0);
    }
    if (disposition !== "queue") endStreamingText();
    // `scheduled` tells the sidecar nobody is watching this run, so an
    // ask_user in it gets the short (autopilot) deadline.
    const sent = sendPrompt(trimmed, [], opts?.scheduled ? { scheduled: true } : undefined);
    if (opts?.onError) void sent.catch(opts.onError);
    else void sent;
    return true;
  }

  // Scheduled prompts fire from a ticker that is set up once, so it can't close
  // over this render's `submitText`. The ref keeps the ticker pointed at the
  // current one without re-creating the interval on every render.
  const submitTextRef = useRef(submitText);
  submitTextRef.current = submitText;

  // Return to chat without consuming the draft. Agent setup runs the existing
  // /init workflow; audits require a recorded result, never an inferred pass.
  function handleRunChecklistItem(item: ChecklistEntry): void {
    const setup = item.id === "agent-setup";
    const prompt = setup ? "/init" : item.runPrompt;
    if (prompt === null || running || checklistRunRef.current || !readyRef.current) return;
    const run = { id: item.id, checkedAt: item.checkedAt, expectsRecord: !setup };
    checklistRunRef.current = run;
    setChecklistRunId(item.id);
    setChecklistNotice(null);
    const failed = (): void => {
      if (checklistRunRef.current !== run) return;
      checklistRunRef.current = null;
      setChecklistRunId(null);
      setChecklistNotice({
        id: item.id,
        checkedAt: item.checkedAt,
        message: setup
          ? "Couldn't start /init. Try again."
          : "Couldn't start this check. Try again.",
      });
    };
    if (
      submitText(prompt, setup ? "/init" : `Checking ${item.title}`, {
        keepInput: true,
        onError: failed,
      })
    ) {
      setShowChecklist(false);
    } else {
      failed();
    }
  }

  // Project Health → agent. The prompt (from the sidecar) has the agent check
  // the findings and ask with ask_user before fixing anything. Like a checklist
  // run it leaves the composer draft alone and returns to the chat.
  function reviewProjectHealth(prompt: string, label: string): boolean {
    if (!submitText(prompt, label, { keepInput: true })) return false;
    setDeckPanel(null);
    return true;
  }

  // A question whose answer the user chose to TYPE rather than click. The next
  // composer submit belongs to it, not to a new prompt.
  const typingAskRef = useRef<{ itemId: number; promptId: string; questionId: string } | null>(
    null,
  );

  // Is a question still waiting on the user? Checked at send time only — the
  // transcript can run to thousands of rows, so this must not scan on every
  // keystroke-driven render.
  function hasOpenAsk(): boolean {
    return items.some((it) => it.kind === "ask" && it.sent !== true && it.cancelled !== true);
  }

  // A prompt sent while a question band is open supersedes it: the user chose
  // to say something else entirely. The sidecar releases the parked tool call
  // when that prompt lands, so the band can never be answered again — drop it
  // instead of leaving dead buttons in the transcript.
  const dismissOpenAsks = useCallback(() => {
    setItems(dropSupersededAsks);
    typingAskRef.current = null;
  }, [setItems]);

  // Text of the prompt that superseded a question and is now briefly sitting in
  // the sidecar's steering queue. Kept out of the queued strip until the agent
  // consumes it — see withoutSupersedingMessage.
  const supersedingTextRef = useRef<string | null>(null);
  const [supersedingText, setSupersedingText] = useState<string | null>(null);
  const supersedeClearRef = useRef<number | null>(null);
  const noteSupersedingSend = useCallback((text: string) => {
    supersedingTextRef.current = text;
    setSupersedingText(text);
    // Safety net: if the message never shows up in a queue broadcast at all
    // (the run ended between typing and sending, so it started a fresh turn),
    // nothing would ever clear the filter and a later identical message would
    // be missing from the strip.
    if (supersedeClearRef.current !== null) window.clearTimeout(supersedeClearRef.current);
    supersedeClearRef.current = window.setTimeout(() => {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }, 5000);
  }, []);
  useEffect(() => {
    const text = supersedingTextRef.current;
    if (text === null) return;
    // Gone from the queue: the agent took it, so stop filtering — otherwise a
    // later identical message would be hidden from the strip forever.
    if (!queuedMessages.some((m) => m.text === text)) {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }
  }, [queuedMessages]);
  const visibleQueuedMessages = useMemo(
    () => withoutSupersedingMessage(queuedMessages, supersedingText),
    [queuedMessages, supersedingText],
  );
  // Ultracode turns' phase strips; the last turn is live while the run goes.
  const ultracodePhaseMap = useMemo(() => {
    const out = new Map<number, UltracodePhase[]>();
    const turns = [...ultracodeTurns(items)];
    turns.forEach(([userId, turn], i) => {
      const phases = ultracodePhases(turn, running && i === turns.length - 1);
      if (phases) out.set(userId, phases);
    });
    return out;
  }, [items, running]);
  // The running turn's checklist, pinned above the deck so it stays in view.
  const liveTodos = useMemo(() => {
    if (!running) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "todos") return item.settled ? undefined : item;
    }
    return undefined;
  }, [items, running]);
  // Sub-agent groups for the critter floor. Recomputed with `items`, but the
  // floor compares group identities and ignores token-only re-renders.
  const critterGroups = useMemo(
    () =>
      items.filter(
        (item): item is Extract<Item, { kind: "subagent_group" }> & CritterGroup =>
          item.kind === "subagent_group",
      ),
    [items],
  );

  // Click handler for the "Send to GG Coder" button on Ken's recommended prompts.
  // Pushes a shimmering "Sent to GG Coder" user bubble (the full prompt body went
  // to GG Coder, but the transcript shows the short Ken-colored label, like a
  // slash command shows `/name`), then sends the prompt to the build session.
  // A failed send drops the bubble and says so; resolving false lets the
  // prompt block re-enable its button.
  const sendKenRecommendedPrompt = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || !readyRef.current) return false;
      stickToBottomRef.current = true;
      dismissOpenAsks();
      const bubbleId = nextId();
      pushItem({ kind: "user", id: bubbleId, text: trimmed, kenSent: true });
      endStreamingText();
      try {
        await sendPrompt(trimmed, [], { kenSent: true });
        return true;
      } catch (error) {
        setItems((prev) => prev.filter((it) => it.id !== bubbleId));
        pushItem({
          kind: "error",
          id: nextId(),
          ...readChatError(
            {
              headline: "Israel's prompt wasn't sent",
              message: error instanceof Error ? error.message : String(error),
              guidance: "Click Send to Israel Code again when the agent is ready.",
              reason: "network",
            },
            "error",
          ),
        });
        return false;
      }
    },
    [pushItem, endStreamingText, dismissOpenAsks, stickToBottomRef],
  );

  // Record answers for an `ask_user` band, and settle the parked tool call once
  // every question in it has one — the band carries no send button, so the last
  // answer IS the send. App owns the merge because an answer can also arrive
  // from the composer, outside the band.
  //
  // The POST is optimistic: a failed one means the question already timed out or
  // the run was cancelled, and re-opening the band would hand the user a button
  // that can no longer reach anyone.
  //
  // The finished answer moves to the end of the conversation (see
  // answerAskItem): it reads as sent the way a typed prompt does, and the chat
  // follows it down even when the question was far up in the scrollback.
  const answerAsk = useCallback(
    (itemId: number, promptId: string, delta: Record<string, string | string[]>) => {
      const result = answerAskItem(
        windowRef.current.items,
        itemId,
        delta,
        (it) => (it.kind === "ask" ? it.prompt.questions : []),
        nextId,
      );
      if (result.completed) {
        // Sending is the user's own action: back to the bottom, like submit.
        stickToBottomRef.current = true;
        void answerAskUser(promptId, "answer", result.completed).catch(() => {});
      }
      setItems(result.items);
    },
    [setItems, stickToBottomRef, windowRef],
  );

  // "Something else" on a question: send the user to the composer they already
  // type in (seeded, when they got here by typing a character) instead of a
  // second input inside the transcript.
  const typeAskInstead = useCallback(
    (itemId: number, promptId: string, questionId: string, seed?: string) => {
      typingAskRef.current = { itemId, promptId, questionId };
      if (seed) setInput((current) => current + seed);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  // When the current run began, and what the activity bar says about it.
  const { runStartedAt, barActivity } = useRunActivity({ items, running, activity });
  // ── Goal world ── (useGoalWorld.ts)
  const {
    setGoalChatFor,
    setGoalPaused,
    workspaceHeaderRef,
    activeGoalId,
    goalView,
    goalWorldOpen,
    goalWaitingOnUser,
    goalWorkers,
    goalAskNotice,
    kenSaid,
    shownGoalFinish,
    setGoalFinish,
    kenStatus,
    goalTally,
  } = useGoalWorld({
    state,
    running,
    requestCancel,
    items,
    critterGroups,
    liveText,
    liveToolFeed,
    goalRuns,
    goalRunTargetRef,
    transcriptEpoch,
    scrollRef,
    transcriptFrameRef,
    dockElRef,
    stickToBottomRef,
    lastScrollTopRef,
    scrollToBottom,
  });

  const { recordHistory, navigateHistory } = usePromptHistory({
    promptHistoryRef,
    historyDraftRef,
    historyIndex,
    setHistoryIndex,
    setInput,
    inputRef,
  });

  const { runEnhance, onEnhanceAnimDone } = usePromptEnhance({
    input,
    setInput,
    inputRef,
    enhancing,
    setEnhancing,
    setEnhanceHintVisible,
    setEnhanceAnim,
    pendingEnhanceRef,
    enhancement,
    setEnhancement,
    hydrated,
    slashOpen,
    mentionOpen,
    scheduleDraft,
  });

  // Enter in the composer (composer-submit.ts).
  const { submit } = createComposerSubmit({
    input,
    setInput,
    attachments,
    setAttachments,
    clearAttachments,
    attachmentReadsRef,
    mentionedPaths,
    setMentionedPaths,
    setMention,
    setSlashIndex,
    enhancement,
    setEnhancement,
    setSendCount,
    setItems,
    pushItem,
    endStreamingText,
    chatLayout,
    stickToBottomRef,
    readyRef,
    typingAskRef,
    answerAsk,
    hasOpenAsk,
    dismissOpenAsks,
    noteSupersedingSend,
    isWorkflowCommand,
    recordHistory,
    workspaceMode,
    state,
    running,
    submitShell,
    markShellShared,
    addSchedule,
    rewindAvailable,
    setRewindAt,
    ultracodeAvailable,
    ultracodeArmed,
    orchestrateKeyword,
    changeUltracode,
  });

  // Plan review actions (mirror the ggcoder CLI plan overlay): plan-review-actions.ts.
  const planActions = createPlanReviewActions({
    planReview,
    setPlanReview,
    setPlanReviewAttempt,
    planReviewPathRef,
    pendingPlanTotalRef,
    pushItem,
    endStreamingText,
  });

  // Start a fresh session on this window's project. Clears the transcript only
  // after the sidecar confirms (it emits `session_reset`, handled below).
  async function startNewSession(): Promise<void> {
    if (newSessionBusy || running) return;
    setNewSessionBusy(true);
    try {
      await newSession();
      setConfirmNewSession(false);
    } catch {
      // Surface nothing extra — agent.ts logged it; keep the modal open.
    } finally {
      setNewSessionBusy(false);
    }
  }

  // Re-point this window at a freshly chosen project: clear the old transcript
  // and force a re-hydrate against the new sidecar. Bumping the nonce re-runs
  // the hydrate effect even when needsProject is already false (switching
  // sessions from the reopened picker), which flipping the boolean alone won't.
  function onProjectChosen(): void {
    // Picker → workspace switches like every other screen change (showScreen).
    showScreen(resetForChosenProject);
  }
  // The Git panel's branch picker put this window's branch in its own
  // worktree (other windows share this folder): re-open there, same conversation.
  async function moveToWorktree(cwd: string, sessionPath: string | null): Promise<void> {
    await selectProject(cwd, sessionPath ?? undefined);
    setDeckPanel(null);
    onProjectChosen();
  }
  // Reattach (or reopen) a background conversation exactly as the pickers do:
  // point this window at it, then reset and re-hydrate. Never starts a run.
  async function openBackgroundSession(row: BackgroundSessionRow): Promise<void> {
    if (!row.sessionPath) return;
    await selectWorkspace(
      row.mode,
      row.cwd,
      row.sessionPath,
      row.chatAgent === "therapist" || row.chatAgent === "research" ? row.chatAgent : "general",
    );
    showScreen(() => {
      setWorkspaceMode(row.mode);
      setShowPicker(false);
      resetForChosenProject();
    });
  }
  function resetForChosenProject(): void {
    // Leaving a task mid-run: it carries on in the daemon. Say so, once.
    if (running) noteBackgroundHandoff();
    checklistFetchRef.current++;
    checklistRunRef.current = null;
    setShowChecklist(false);
    setChecklistRunId(null);
    setChecklistNotice(null);
    setChecklistLoad({ kind: "loading" });
    stickToBottomRef.current = true;
    setItems([]);
    // A new project has no previous layout to carry into a transaction.
    updateLiveToolFeed([]);
    setState(null);
    setTasks([]);
    setContextTokens(0);
    // The done line + token tail belong to the run we're navigating away from;
    // leaving them up makes a brand-new session open on someone else's
    // "Brewed up a response in 14s · 800 tokens".
    setTokens(0);
    setDoneStatus(null);
    setPlanReview(null);
    planTotalRef.current = 0;
    planDoneRef.current = new Set();
    setPlanTotal(0);
    setPlanDone(new Set());
    attachmentGenerationRef.current++;
    attachmentReadsRef.current = 0;
    setAttachmentsLoading(false);
    setAttachments([]);
    setQueuedCount(0);
    updateQueuedMessages([]);
    setHydrated(false);
    setNeedsProject(false);
    setHydrateNonce((n) => n + 1);
  }

  // Show explicit recovery feedback while Rust resolves this window's durable
  // target. This branch used to paint only the dark background, which looked
  // indistinguishable from a dead/black webview during a slow recovery.
  if (needsProject && !restoreChecked) {
    return (
      <div className="app app-restoring" style={{ background: theme.background }}>
        <div className="app-restoring-status" role="status" aria-live="polite">
          <span className="app-restoring-dot" aria-hidden="true" />
          Restoring workspace…
        </div>
      </div>
    );
  }

  // World (one layer for every screen, so changing screen under it never reloads the game) and the in-game
  // computer: while it's open this window's GG Coder sits inside a monitor over World (.app-in-monitor).
  // World's Back always lands on GG Coder's Home screen (owner), never on whatever the in-game computer was last
  // showing. A session opened there keeps running and is one click away from Home.
  const closeWorld = (): void =>
    showScreen(() => {
      setShowWorld(false);
      setWorldShown(false);
      setWorldComputer(false);
      setShowPicker(false);
      setNeedsProject(true);
      setEntryView("home");
    });
  const onWorldComputer = (open: boolean): void => {
    setWorldComputer(open);
    // The computer always boots to GG Coder's Home screen (owner), whatever this window was showing: the same way
    // the app's own Back gets there (a running session carries on underneath and is one click away again).
    if (open) {
      setShowPicker(false);
      setNeedsProject(true);
      setEntryView("home");
    }
  };
  // The command palette and shortcuts sheet (commands/): what this screen can do.
  const inWorkspace = !needsProject && !showPicker;
  const workspaceCwd = inWorkspace ? state?.cwd : undefined;
  const codeTools = inWorkspace && workspaceMode === "code" && !state?.goal;
  const openSettingsPage = (tab: SettingsTabId): void =>
    showScreen(() => {
      setShowPicker(false);
      setNeedsProject(true);
      setSettingsTab(tab);
      setEntryView("settings");
    });
  const openProjectFromPalette = (path: string): void => {
    void selectProject(path)
      .then(() =>
        showScreen(() => {
          setWorkspaceMode("code");
          setShowPicker(false);
          resetForChosenProject();
        }),
      )
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
  };
  const commandHandlers: Omit<CommandHandlers, "openShortcuts"> = {
    toggleTheme: () =>
      setColorSchemePref(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
    openWhatsNew: () => void openWhatsNewWindow("calm").catch(() => {}),
    openSettings: openSettingsPage,
    newWindow: () => void newWindow(),
    nextWindow: () => void focusWindowByOffset(1),
    prevWindow: () => void focusWindowByOffset(-1),
    arrangeWindows: () => void arrangeAllWindows(),
    goHome: () =>
      showScreen(() => {
        setShowPicker(false);
        setNeedsProject(true);
        setEntryView("home");
      }),
    openProjects: () =>
      showScreen(() => {
        setShowPicker(false);
        setNeedsProject(true);
        setWorkspaceMode("code");
        setEntryView("projects");
      }),
    ...(inWorkspace && {
      newSession: running ? undefined : () => setConfirmNewSession(true),
      backToSessions: () => showScreen(() => setShowPicker(true)),
      openNotes: () => setDeckPanel("notes"),
      openMemories: () => setDeckPanel("brain"),
      exportTranscript: items.length > 0 ? () => void exportTranscript() : undefined,
      toggleTools,
      thinkingLevels: state?.supportedThinkingLevels,
      thinkingLevel: state?.thinkingLevel,
      setThinking: running
        ? undefined
        : (level: string) =>
            void setThinkingLevel(level)
              .then((r) => setState((s) => (s ? { ...s, ...r } : s)))
              .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error")),
    }),
    ...(codeTools && {
      openChecklist,
      openTasks,
      cyclePermission,
      planOn: state?.planMode ?? false,
      togglePlan:
        running && !state?.planMode
          ? undefined
          : () =>
              void setPermissionMode(state?.planMode ? (state.permissionMode ?? "ask") : "plan")
                .then((r) =>
                  setState((s) =>
                    s ? { ...s, permissionMode: r.permissionMode, planMode: r.planMode } : s,
                  ),
                )
                .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error")),
      autopilotOn: state?.autopilot ?? false,
      toggleAutopilot: () => {
        const next = !(state?.autopilot ?? false);
        setState((s) => (s ? { ...s, autopilot: next } : s));
        void setAutopilot(next);
        setKenPowerBanner(next ? "on" : "off");
      },
      ...(ultracodeAvailable && {
        ultracodeOn: state?.ultracode ?? false,
        toggleUltracode: () => changeUltracode(!(state?.ultracode ?? false)),
        orchestrateOn: state?.orchestration?.orchestrate ?? false,
        toggleOrchestrate: () => changeOrchestrate(!(state?.orchestration?.orchestrate ?? false)),
      }),
    }),
  };
  const projectLoader = projectCommands(openProjectFromPalette);
  const sessionLoader = workspaceCwd
    ? sessionCommands(workspaceCwd, workspaceMode, (session) => {
        void selectWorkspace(workspaceMode, workspaceCwd, session.path, session.chatAgent)
          .then(() =>
            showScreen(() => {
              setShowPicker(false);
              resetForChosenProject();
            }),
          )
          .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
      })
    : null;
  const modelLoader = inWorkspace ? modelCommands(state?.model, (m) => onSelectModel(m.id)) : null;
  const switchLoaders = sessionLoader ? [projectLoader, sessionLoader] : [projectLoader];
  const modelLoaders = modelLoader ? [modelLoader] : [];
  const commandCenter = (
    <CommandCenter
      handlers={commandHandlers}
      loaders={[...switchLoaders, ...modelLoaders]}
      switchLoaders={switchLoaders}
      modelLoaders={modelLoaders}
    />
  );
  const inMonitor = monitorOpen ? " app-in-monitor" : "";
  const worldLayer = showWorld ? (
    <div className="world-overlay">
      <Suspense fallback={null}>
        <LazyWorldScreen.Component
          player={progress}
          onShown={() => setWorldShown(true)}
          onClose={closeWorld}
          computer={worldComputer}
          onComputer={onWorldComputer}
        />
      </Suspense>
    </div>
  ) : null;

  if (needsProject) {
    return (
      <>
        <div
          className={`app${windowFocused ? " window-focused" : ""}${inMonitor}`}
          style={{ background: theme.background }}
        >
          {/* World opens OVER Home (as it does over a workspace), so Home
            stays put underneath while the game fades in, and Back fades
            straight back to it. */}
          <EntryScreen
            entryView={entryView}
            setEntryView={setEntryView}
            setWorkspaceMode={setWorkspaceMode}
            worldComputer={worldComputer}
            setWorldComputer={setWorldComputer}
            setShowWorld={setShowWorld}
            worldShown={worldShown}
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            homeRefreshSignal={homeRefreshSignal}
            setHomeRefreshSignal={setHomeRefreshSignal}
            onOpenBackground={openBackgroundSession}
            onChosen={onProjectChosen}
          />
          {showTraySettings && (
            <Suspense fallback={null}>
              <LazySettingsModal.Component onClose={closeTraySettings} />
            </Suspense>
          )}
          {commandCenter}
          <Toaster />
        </div>
        {worldLayer}
      </>
    );
  }

  // Picker reopened over an already-open workspace. Back from the picker returns
  // to the home screen; choosing a session resets and re-hydrates this window.
  if (showPicker) {
    const pickerProps = {
      onChosen: () =>
        showScreen(() => {
          setShowPicker(false);
          resetForChosenProject();
        }),
      onClose: () =>
        showScreen(() => {
          setShowPicker(false);
          setNeedsProject(true);
          setEntryView("home" as const);
        }),
    };
    return (
      <>
        <div
          className={`app${windowFocused ? " window-focused" : ""}${inMonitor}`}
          style={{ background: theme.background }}
        >
          {workspaceMode === "chat" ? (
            <ChatPicker initialAgent={state?.chatAgent ?? "general"} {...pickerProps} />
          ) : workspaceMode === "motion" ? (
            <ChatPicker mode="motion" {...pickerProps} />
          ) : state?.goal ? (
            <Suspense fallback={null}>
              <GoalPicker {...pickerProps} />
            </Suspense>
          ) : (
            <ProjectPicker
              initialProjectPath={state?.worktreeOf ?? state?.cwd ?? null}
              {...pickerProps}
            />
          )}
          {showTraySettings && (
            <Suspense fallback={null}>
              <LazySettingsModal.Component onClose={closeTraySettings} />
            </Suspense>
          )}
          {commandCenter}
          {/* Tray Settings can toast a save failure over the picker. */}
          <Toaster />
        </div>
        {worldLayer}
      </>
    );
  }

  const backLabel =
    workspaceMode === "chat"
      ? "Back to chats"
      : workspaceMode === "motion"
        ? "Back to motion sessions"
        : "Back to this project's sessions";
  const goBack = (): void => {
    const back = (): void => setShowPicker(true);
    showScreen(back);
  };
  const closeDeckThen =
    (run: () => void): (() => void) =>
    () => {
      setDeckPanel(null);
      run();
    };

  return (
    <>
      <div
        className={`app${isFileDragOver ? " app-file-dragover" : ""}${windowFocused ? " window-focused" : ""}${goalWorldOpen ? " goal-world-open" : ""}${inMonitor}`}
        data-glow={glowState}
        style={{ background: theme.background, ...glowStyle }}
        onDragEnter={handleWindowDragEnter}
        onDragOver={handleWindowDragOver}
        onDragLeave={handleWindowDragLeave}
        onDrop={handleWindowDrop}
      >
        {confettiNonce && <Confetti key={confettiNonce} />}

        <WorkspaceHeader
          ref={workspaceHeaderRef}
          workspaceMode={workspaceMode}
          cwd={state?.cwd}
          goalName={state?.goal?.name ?? null}
          gitBranch={state?.gitBranch}
          gitDirtyFileCount={state?.gitDirtyFileCount}
          gitHubIssues={state?.gitHubIssues}
          gitHubPRs={state?.gitHubPRs}
          additionalRoots={state?.additionalRoots}
          subtitle={
            workspaceMode === "chat"
              ? state?.chatAgent === "therapist"
                ? "Therapist"
                : state?.chatAgent === "research"
                  ? "Research"
                  : "General"
              : null
          }
          leading={<BackButton label={backLabel} onClick={goBack} />}
          trailing={
            <TitleBarActions
              onOpenBackground={openBackgroundSession}
              workspaceMode={workspaceMode}
              isGoal={Boolean(state?.goal)}
              goalView={goalView}
              // No view transition: WebKit leaves the header's frost (backdrop
              // blur) out of its snapshots, so it popped in after the crossfade.
              onGoalViewChange={(view) => setGoalChatFor(view === "chat" ? activeGoalId : null)}
              goalNeedsAnswer={goalWaitingOnUser}
              goalTally={goalTally}
              goalState={
                state?.goal?.paused
                  ? "paused"
                  : running || (goalTally?.working ?? 0) > 0
                    ? "running"
                    : "stopped"
              }
              onGoalPauseChange={state?.goal?.phase === "active" ? setGoalPaused : undefined}
              xpChips={xpChips}
              budget={state?.budget ?? null}
              onBudgetChange={(next) => setState((s) => (s ? { ...s, budget: next } : s))}
              running={running}
              dirtyCount={state?.gitDirtyFileCount ?? 0}
              needsGitInit={needsGitInit}
              onInitGit={() => setShowInitGit(true)}
              commitCommand={commitCommand}
              hasCommit={hasCommit}
              onCommit={() =>
                submitText(
                  `/${commitCommand}`,
                  hasCommit ? "Committing\u2026" : "Setting up commits\u2026",
                )
              }
            />
          }
        />

        {/* Kept alive while hidden (Chat view), so switching back doesn't rebuild the farm. */}
        {activeGoalId && (
          <Activity mode={goalWorldOpen ? "visible" : "hidden"}>
            <Suspense fallback={null}>
              <GoalWorld
                key={activeGoalId}
                headerRef={workspaceHeaderRef}
                goalId={activeGoalId}
                running={running}
                liveTools={liveToolFeed}
                waitingOnUser={goalWaitingOnUser}
                workers={goalWorkers}
                ask={goalAskNotice}
                kenSaid={kenSaid}
                onShowChat={() => setGoalChatFor(activeGoalId)}
                finish={shownGoalFinish}
                onCloseFinish={() => setGoalFinish(null)}
                kenStatus={kenStatus}
              />
            </Suspense>
          </Activity>
        )}

        {/* React owns chat visibility rather than a stylesheet override. Activity
          keeps the draft and transcript state, and suspends hidden child effects. */}
        <Activity mode={goalWorldOpen ? "hidden" : "visible"}>
          {/* Non-scrolling frame the same size as the chat viewport. The banner
          lives HERE, not inside `.transcript` — `.transcript` scrolls, and an
          absolutely positioned child of a scrolling container is pinned to the
          top of the scrolled CONTENT, not the visible viewport, so in an
          existing session scrolled down it rendered far above what's on
          screen. Anchoring to this non-scrolling sibling keeps it pinned to
          what the user is actually looking at, at any scroll position. */}
          <TranscriptView
            transcriptFrameRef={transcriptFrameRef}
            attachTranscript={attachTranscript}
            scroll={transcriptScroll}
            workspaceMode={workspaceMode}
            kenPowerBanner={kenPowerBanner}
            onKenPowerBannerDone={() => setKenPowerBanner(null)}
            hydrated={hydrated}
            items={items}
            connectError={connectError}
            onRetried={() => setHydrateNonce((n) => n + 1)}
            status={status}
            state={state}
            sendKenRecommendedPrompt={sendKenRecommendedPrompt}
            liveText={liveText}
            ultracodePhaseMap={ultracodePhaseMap}
            chatView={chatView}
            liveFromId={liveFromId}
            entrances={entrances}
            talkingKenId={talkingKenId}
            currentErrorId={currentErrorId}
            models={models}
            onSelectKenModel={onSelectKenModel}
            onSelectModel={onSelectModel}
            modelSwitchDisabled={running || kenRunning || autopilotReviewing}
            answerAsk={answerAsk}
            typeAskInstead={typeAskInstead}
            onRewind={rewindAvailable && !running ? setRewindAt : undefined}
            shellActions={shellActions}
          />

          {/* The dock: everything below the conversation, floating over its
          bottom edge so messages scroll on behind it through a frost (the
          title bar's, mirrored). The transcript reserves the dock's height as
          padding (--dock-h, kept current by a ResizeObserver). */}
          <div ref={dockRef} className="dock">
            {/* Sub-agents walk on top of the pinned region as critters; the lane
          opens (pushing the chat up) only while one is out. */}
            <CritterFloor groups={critterGroups} />
            <div ref={liveRegionRef} className="liveregion">
              {/* Motion's starting points sit just above the deck and go away once
            the conversation has its first message. */}
              {workspaceMode === "motion" && hydrated && items.length === 0 && !running && (
                <MotionStarters onPick={fillComposer} />
              )}
              {state?.pendingApprovals && state.pendingApprovals.length > 0 && (
                <ApprovalCard approvals={state.pendingApprovals} onAnswer={answerApproval} />
              )}
              {liveTodos && <TodoPill todos={liveTodos.todos} />}
              {!toolsHidden && <LiveToolPanel entries={liveToolFeed} />}
            </div>

            <Deck
              state={state}
              hydrated={hydrated}
              // A Goal works in a git repo too: its branch key opens the Git panel.
              showGit={workspaceMode === "code"}
              onMoveToWorktree={
                workspaceMode === "code" && !state?.goal ? moveToWorktree : undefined
              }
              panel={deckPanel}
              onPanelChange={setDeckPanel}
              running={running}
              contextPct={contextPct}
              compaction={
                workspaceMode === "code" && !state?.goal ? (state?.compaction ?? null) : null
              }
              onCompactionChange={changeCompaction}
              models={models}
              modelsFailed={modelsFailed}
              onSelectModel={onSelectModel}
              second={
                state?.goal
                  ? {
                      name: "Critters",
                      followLabel: "Israel Goals",
                      model: state.goal.critterModel ?? state.model,
                      following: !state.goal.critterModel,
                      disabled: false,
                      onSelect: onSelectCritterModel,
                    }
                  : workspaceMode === "code" && state
                    ? {
                        name: "Israel",
                        followLabel: "Israel Code",
                        model: state.kenModel ?? state.model,
                        following: !state.kenModelOverride,
                        disabled: running || kenRunning || autopilotReviewing,
                        onSelect: onSelectKenModel,
                      }
                    : null
              }
              third={
                workspaceMode === "code" && state && !state.goal
                  ? {
                      name: "Workers",
                      followLabel: "Israel Code",
                      model: state.orchestration?.workerModel ?? state.model,
                      following: !state.orchestration?.workerModel,
                      disabled: false,
                      onSelect: onSelectWorkerModel,
                    }
                  : null
              }
              onUltracodeChange={ultracodeAvailable ? changeUltracode : undefined}
              onOrchestrateChange={ultracodeAvailable ? changeOrchestrate : undefined}
              tasks={tasks}
              schedules={schedules}
              onStopSchedule={stopSchedule}
              projectHealth={projectHealth}
              onReviewHealth={reviewProjectHealth}
              tools={{
                notes: {
                  title: "Notes",
                  meta: "Saved on this Mac",
                  body: (
                    <LazyNotesModal.Component
                      value={notes}
                      onChange={handleNotesChange}
                      onClose={() => closeDeckPanel("notes")}
                    />
                  ),
                },
                todo:
                  workspaceMode === "code"
                    ? {
                        title: "Tasks",
                        meta: `${projectTasks.filter((t) => t.status !== "done").length} pending`,
                        body: (
                          <LazyTasksModal.Component
                            tasks={projectTasks}
                            running={running}
                            onRun={handleRunTask}
                            onRunAll={handleRunAllTasks}
                            onDelete={handleDeleteTask}
                            onClose={() => closeDeckPanel("todo")}
                          />
                        ),
                      }
                    : undefined,
                checklist:
                  workspaceMode === "code" && !state?.goal
                    ? {
                        title: "Checklist",
                        meta:
                          checklistLoad.kind === "ready"
                            ? `${checklistLoad.snapshot.items.filter((i) => i.status === "passed").length} of ${checklistLoad.snapshot.items.length} passing`
                            : undefined,
                        body: (
                          <LazyChecklistScreen.Component
                            load={checklistLoad}
                            running={running || checklistRunId !== null}
                            activeId={checklistRunId}
                            notice={checklistNotice}
                            onRun={handleRunChecklistItem}
                            onRetry={() => {
                              setChecklistLoad({ kind: "loading" });
                              void refreshChecklist();
                            }}
                          />
                        ),
                      }
                    : undefined,
                // Goal windows show the attached project's score too (Usage →
                // Project Health), so the breakdown must open there as well.
                health:
                  workspaceMode === "code"
                    ? {
                        title: "Project Health",
                        body: (
                          <ProjectHealthPanel
                            health={projectHealth}
                            onReview={reviewProjectHealth}
                            onDone={() => closeDeckPanel("health")}
                          />
                        ),
                      }
                    : undefined,
                goal: state?.goal
                  ? {
                      title: "Goal settings",
                      body: (
                        <LazyGoalSettingsModal.Component
                          context={state.goal.context ?? []}
                          instructions={state.goal.instructions ?? ""}
                          busy={running}
                          onClose={() => closeDeckPanel("goal")}
                          onSaved={(next) => {
                            setState((s) => (s?.goal ? { ...s, goal: { ...s.goal, ...next } } : s));
                            // Newly attached repos bring their own slash commands.
                            refreshCommands();
                          }}
                        />
                      ),
                    }
                  : undefined,
                scorecard: progress
                  ? { title: "Scorecard", body: <ScorecardPanel snapshot={progress} /> }
                  : undefined,
                brain:
                  workspaceMode === "chat"
                    ? {
                        title: "Brain",
                        body: <LazyMemoryModal.Component onClose={() => closeDeckPanel("brain")} />,
                      }
                    : undefined,
              }}
              progress={progress}
              trophies={trophies.snapshot}
              onOpenWorld={() =>
                void LazyWorldScreen.preload().then(() => showScreen(() => setShowWorld(true)))
              }
              usageExtras={
                windowTotal > 1 &&
                windowIndex !== null && (
                  <span
                    className="deck-pm"
                    title={`Window ${windowIndex} of ${windowTotal} · ⌘\` to cycle`}
                  >
                    Window {windowIndex} of {windowTotal}
                  </span>
                )
              }
              menu={
                <DeckMenu
                  workspaceMode={workspaceMode}
                  isGoal={Boolean(state?.goal)}
                  running={running}
                  autopilot={state?.autopilot ?? false}
                  autopilotReviewing={autopilotReviewing}
                  verify={state?.verify ?? null}
                  onVerifyChange={changeVerify}
                  worktreeWorkers={state?.worktreeWorkers ?? null}
                  worktreeVerifyProgress={state?.worktreeVerifyProgress}
                  onWorktreeWorkersChange={changeWorktreeWorkers}
                  onAutopilotChange={(next) => {
                    setState((s) => (s ? { ...s, autopilot: next } : s));
                    void setAutopilot(next);
                    setKenPowerBanner(next ? "on" : "off");
                  }}
                  onNewSession={closeDeckThen(() => setConfirmNewSession(true))}
                  onOpenNotes={() => setDeckPanel("notes")}
                  onOpenMemories={() => setDeckPanel("brain")}
                  projectTasks={projectTasks}
                  onOpenTasks={openTasks}
                  showChecklist={showChecklist}
                  onOpenChecklist={openChecklist}
                  hasHealth={projectHealth !== null}
                  onOpenHealth={() => setDeckPanel("health")}
                  onOpenRadio={() => setDeckPanel("radio")}
                  onOpenGoalSettings={state?.goal ? () => setDeckPanel("goal") : undefined}
                  canExport={items.length > 0}
                  exporting={exporting}
                  onExport={closeDeckThen(() => void exportTranscript())}
                  onArrange={() => setToolsHiddenPersisted(true)}
                  onBack={closeDeckThen(goBack)}
                  backLabel={backLabel}
                />
              }
              status={
                /* The deck's status line is whoever is working: a manual @Ken
                 reply shows Israel's bar there in place of Israel Code's (an automatic
                 review stays in Israel Code's task row). */
                workspaceMode === "code" && kenRunning && !running && !autopilotReviewing ? (
                  <KenActivityBar
                    runStartTs={kenRunStartTs}
                    tokens={kenTokens}
                    toolsHidden={toolsHidden}
                    onToggleTools={toggleTools}
                  />
                ) : (
                  <ActivityBar
                    running={running}
                    runStartedAt={runStartedAt}
                    activity={barActivity}
                    cancelling={cancelling}
                    tokens={tokens}
                    doneStatus={doneStatus}
                    isThinking={isThinking}
                    thinkingStartTs={thinkingStartTs}
                    thinkingAccumMs={thinkingAccumMs}
                    planTotal={workspaceMode !== "code" ? 0 : planTotal}
                    planDone={workspaceMode !== "code" ? 0 : Math.min(planDone.size, planTotal)}
                    toolsHidden={toolsHidden}
                    hasToolFeed={liveToolFeed.length > 0}
                    onToggleTools={toggleTools}
                  />
                )
              }
              composer={
                <Composer
                  workspaceMode={workspaceMode}
                  state={state}
                  composerRef={composerRef}
                  isFileDragOver={isFileDragOver}
                  scheduleInvalid={scheduleInvalid}
                  scheduleDraft={scheduleDraft}
                  ultracodeArmed={ultracodeArmed}
                  onRewindShortcut={rewindAvailable && !running ? () => setRewindAt("") : undefined}
                  permissionPill={
                    rewindAvailable
                      ? currentPill(state?.permissionMode, state?.planMode)
                      : undefined
                  }
                  onCyclePermission={rewindAvailable ? cyclePermission : undefined}
                  onDismissUltracode={() => setUltracodeDismissed(true)}
                  running={running}
                  kenRunning={kenRunning}
                  autopilotReviewing={autopilotReviewing}
                  cancelling={cancelling}
                  sendDisabled={sendDisabled}
                  input={input}
                  setInput={setInput}
                  caret={caret}
                  setCaret={setCaret}
                  fillScheduleInterval={fillScheduleInterval}
                  slashOpen={slashOpen}
                  slashMatches={slashMatches}
                  clampedSlashIndex={clampedSlashIndex}
                  pickSlashCommand={pickSlashCommand}
                  setSlashIndex={setSlashIndex}
                  mentionOpen={mentionOpen}
                  fileMatches={fileMatches}
                  clampedFileIndex={clampedFileIndex}
                  mention={mention}
                  setMention={setMention}
                  pickMentionFile={pickMentionFile}
                  setFileIndex={setFileIndex}
                  updateMention={updateMention}
                  attachments={attachments}
                  attachmentsLoading={attachmentsLoading}
                  removeAttachment={removeAttachment}
                  addFiles={addFiles}
                  fileInputRef={fileInputRef}
                  mentionedPaths={mentionedPaths}
                  removeMentionChip={removeMentionChip}
                  visibleQueuedMessages={visibleQueuedMessages}
                  sendCount={sendCount}
                  handleCancelQueued={handleCancelQueued}
                  enhanceAnim={enhanceAnim}
                  onEnhanceAnimDone={onEnhanceAnimDone}
                  enhancement={enhancement}
                  setEnhancement={setEnhancement}
                  enhancing={enhancing}
                  enhanceHintVisible={enhanceHintVisible && !shellMode}
                  shellMode={shellMode}
                  shellMenu={shellMenu}
                  runEnhance={runEnhance}
                  kenActive={kenActive}
                  kenInputParts={kenInputParts}
                  attachInput={attachInput}
                  displayPlaceholder={displayPlaceholder}
                  lastKeystrokeAtRef={lastKeystrokeAtRef}
                  historyIndex={historyIndex}
                  setHistoryIndex={setHistoryIndex}
                  navigateHistory={navigateHistory}
                  submit={submit}
                  requestCancel={requestCancel}
                />
              }
            />

            <ShortcutHint />
            <UpdateBanner appUpdate={appUpdate} />
            {commandCenter}
          </div>
        </Activity>

        <WorkspaceModalHost
          workspaceMode={workspaceMode}
          rewindAt={rewindAt}
          setRewindAt={setRewindAt}
          rewindAvailable={rewindAvailable}
          onRewound={finishRewind}
          showInitGit={showInitGit}
          setShowInitGit={setShowInitGit}
          defaultRepoName={defaultRepoName}
          submitText={submitText}
          confirmNewSession={confirmNewSession}
          setConfirmNewSession={setConfirmNewSession}
          newSessionBusy={newSessionBusy}
          startNewSession={startNewSession}
          planReview={planReview}
          planReviewAttempt={planReviewAttempt}
          autopilotReviewing={autopilotReviewing}
          planActions={planActions}
          showTraySettings={showTraySettings}
          closeTraySettings={closeTraySettings}
          trophies={trophies}
          setDeckPanel={setDeckPanel}
        />
      </div>
      {worldLayer}
    </>
  );
}

export default App;
