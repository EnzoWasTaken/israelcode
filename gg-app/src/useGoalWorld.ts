import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { pauseGoal, resumeGoal, type AgentState } from "./agent";
import { collectFloorAgents, type CritterGroup } from "./CritterFloor";
import { finishEntrances } from "./finish-entrances";
import { latestKenLine } from "./goal-ken-talk";
import { kenStatusOf, lastRunOf } from "./goal-ken-status";
import {
  FINISH_SETTLE_MS,
  goalFinishOf,
  goalIsQuiet,
  openStretch,
  type GoalFinish,
  type GoalRun,
} from "./goal-finish";
import {
  EMPTY_TALLY,
  blockingAsk,
  coordinatorAtWork,
  floorPhase,
  tallyGoal,
  type GoalTally,
} from "./goal-progress";
import { COORDINATOR_KEY, goalViewFor } from "./goal-world-agents";
import { dropHiddenFocus } from "./hidden-focus";
import type { LiveTextStore } from "./live-text";
import type { LiveToolEntry } from "./LiveToolPanel";
import { toast } from "./toast";
import type { Item } from "./transcript-item";

/**
 * A started goal's Workers view: the Chat | Workers switch, pause/resume, the
 * chat's scroll position across the switch, the farm's inputs (workers, the
 * question sign, Israel Goals' line and status), the finish card and the
 * header's tally. Extracted from App.tsx.
 */
export function useGoalWorld({
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
}: {
  state: AgentState | null;
  running: boolean;
  requestCancel: () => void;
  items: Item[];
  critterGroups: (Extract<Item, { kind: "subagent_group" }> & CritterGroup)[];
  liveText: LiveTextStore;
  liveToolFeed: LiveToolEntry[];
  goalRuns: readonly GoalRun[];
  goalRunTargetRef: RefObject<string | null>;
  transcriptEpoch: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  transcriptFrameRef: RefObject<HTMLDivElement | null>;
  dockElRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number>;
  scrollToBottom: () => void;
}) {
  // ── Goal world ──
  // A started goal opens on its Workers view: the critters at work, edge to
  // edge, in place of the chat, input and footer. The header's Chat | Workers
  // switch flips between that and the full conversation (with its input).
  const [goalChatFor, setGoalChatFor] = useState<string | null>(null);
  // Pause stops the current run and its workers (the same cancel as Stop) and
  // keeps the goal put, even across restarts; resume carries it on.
  const setGoalPaused = useCallback(
    (paused: boolean) => {
      const act = paused
        ? pauseGoal().then(() => {
            if (running) requestCancel();
          })
        : resumeGoal().then((resumed) => {
            // Nothing was cut short: the goal had simply finished.
            if (!resumed && !state?.goal?.paused) {
              toast(
                "Nothing to carry on: the goal finished. Tell Israel Goals what's next in the chat.",
              );
            }
          });
      void act.catch((e: unknown) =>
        toast(
          `Couldn't ${paused ? "pause" : "resume"} the goal: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        ),
      );
    },
    [running, requestCancel, state?.goal?.paused],
  );
  // The Workers view runs under the (see-through) header; it keeps the
  // workshop clear of whatever height the header has.
  const workspaceHeaderRef = useRef<HTMLDivElement>(null);
  const { activeGoalId, view: goalView } = goalViewFor(state?.goal, goalChatFor);
  const goalWorldOpen = goalView === "workers";
  // The chat stays mounted but hidden behind the Workers view, and a hidden
  // scroller loses its offset. Remember where the reader was when it hid, and
  // put them back on return: at the bottom if they were following, else at
  // the same spot (it otherwise came back pushed up the page).
  const chatScrollOnHideRef = useRef<{ pinned: boolean; top: number } | null>(null);
  useLayoutEffect(() => {
    if (goalWorldOpen) {
      chatScrollOnHideRef.current = {
        pinned: stickToBottomRef.current,
        top: lastScrollTopRef.current,
      };
      dropHiddenFocus();
      return;
    }
    const saved = chatScrollOnHideRef.current;
    chatScrollOnHideRef.current = null;
    // Shown again, not opened: every entrance inside lands at its end at once
    // (see finish-entrances.ts), so the deck and its notices don't replay.
    if (saved) finishEntrances([transcriptFrameRef.current, dockElRef.current]);
    const el = scrollRef.current;
    if (!saved || !el) return;
    stickToBottomRef.current = saved.pinned;
    if (saved.pinned) scrollToBottom();
    else {
      el.scrollTop = saved.top;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [
    goalWorldOpen,
    stickToBottomRef,
    lastScrollTopRef,
    scrollToBottom,
    scrollRef,
    transcriptFrameRef,
    dockElRef,
  ]);
  // And for as long as the farm is up, not just as it opens: the composer can
  // take focus while still visible (its autoFocus on a reload) and be hidden
  // right after.
  useEffect(() => {
    if (!goalWorldOpen) return;
    document.addEventListener("focusin", dropHiddenFocus);
    return () => document.removeEventListener("focusin", dropHiddenFocus);
  }, [goalWorldOpen]);
  const goalWorkers = useMemo(
    () => (activeGoalId ? collectFloorAgents(critterGroups) : []),
    [activeGoalId, critterGroups],
  );
  // GG Goals heads for the mailbox while a question waits on the user.
  const goalWaitingOnUser = useMemo(
    () =>
      activeGoalId !== null &&
      items.some((item) => item.kind === "ask" && !item.sent && !item.cancelled),
    [activeGoalId, items],
  );
  // GG Goals blocked on a question: a sign over the Workers view until the
  // user has gone to the chat while it was waiting (seen), then just the
  // Chat tab's dot until it's answered.
  const goalAsk = useMemo(() => (activeGoalId ? blockingAsk(items) : null), [activeGoalId, items]);
  const [seenGoalAsks, setSeenGoalAsks] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!goalAsk || goalView !== "chat") return;
    setSeenGoalAsks((seen) => (seen.has(goalAsk.id) ? seen : new Set([...seen, goalAsk.id])));
  }, [goalAsk, goalView]);
  const goalAskNotice = useMemo(
    () =>
      goalAsk && !seenGoalAsks.has(goalAsk.id)
        ? { question: goalAsk.question, more: goalAsk.more }
        : null,
    [goalAsk, seenGoalAsks],
  );
  // Ken's newest spoken line (the `[ken:face]` line GG Goals ends a message
  // with), for the Workers view's dialogue box. Finished messages only: the
  // streaming one lives in the live-text store, not `items`.
  const kenSaid = useMemo(
    () => (activeGoalId ? latestKenLine(items, (id) => liveText.get(id) !== undefined) : null),
    [activeGoalId, items, liveText],
  );
  // A stretch of goal work finished (nothing left going, and it stayed that
  // way a moment): the Workers view's end-of-level card, with its score. It
  // comes down when closed, when the user goes to the chat, or when work
  // starts again. Only runs seen live count, so a reopened window shows none.
  useEffect(() => {
    goalRunTargetRef.current = activeGoalId;
  }, [activeGoalId, goalRunTargetRef]);
  const [goalClosedAt, setGoalClosedAt] = useState(0);
  const [goalFinish, setGoalFinish] = useState<GoalFinish | null>(null);
  const goalStretch = useMemo(
    () => (activeGoalId ? openStretch(goalRuns, activeGoalId, goalClosedAt) : []),
    [activeGoalId, goalRuns, goalClosedAt],
  );
  const goalQuiet =
    goalStretch.length > 0 &&
    goalIsQuiet({
      paused: state?.goal?.paused === true,
      running,
      waitingOnUser: goalWaitingOnUser,
      workers: goalWorkers,
    });
  const finishInputsRef = useRef({ groups: critterGroups, said: kenSaid });
  useEffect(() => {
    finishInputsRef.current = { groups: critterGroups, said: kenSaid };
  }, [critterGroups, kenSaid]);
  useEffect(() => {
    if (!goalQuiet) return;
    const timer = window.setTimeout(() => {
      const { groups, said } = finishInputsRef.current;
      const last = goalStretch[goalStretch.length - 1];
      if (last) setGoalClosedAt(last.endedAt);
      setGoalFinish(goalFinishOf(goalStretch, groups, said));
    }, FINISH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [goalQuiet, goalStretch]);
  useEffect(() => {
    if (goalFinish && (running || goalView === "chat")) setGoalFinish(null);
  }, [goalFinish, running, goalView]);
  const shownGoalFinish = goalFinish?.goalId === activeGoalId ? goalFinish : null;
  // What Ken is doing right now, for the Workers view's status pill and the
  // thought mark over his head (see goal-ken-status).
  const goalPaused = state?.goal?.paused === true;
  const goalLastRun = useMemo(
    () => (activeGoalId ? lastRunOf(goalRuns, activeGoalId, items) : null),
    [activeGoalId, goalRuns, items],
  );
  const kenStatus = useMemo(
    () =>
      activeGoalId
        ? kenStatusOf({
            running,
            paused: goalPaused,
            waitingOnUser: goalWaitingOnUser,
            liveTools: liveToolFeed,
            workers: goalWorkers,
            lastRun: goalLastRun,
          })
        : null,
    [activeGoalId, running, goalPaused, goalWaitingOnUser, liveToolFeed, goalWorkers, goalLastRun],
  );
  // The header's counts: workers working now, tasks done and failed so far
  // (see goal-progress). Counting starts afresh for each goal.
  // Restarted when the transcript is reloaded (after a daemon restart, say):
  // the tally counts each worker's change by row key, and reloaded rows get
  // new keys (live bug: "6 done, 6 failed" for a goal that ran 3 workers).
  const tallySource = `${activeGoalId ?? ""}:${transcriptEpoch}`;
  const tallyInput = useMemo(
    () => [
      ...goalWorkers.map((worker) => ({
        key: worker.key,
        phase: floorPhase(worker.status),
      })),
      // GG Goals itself, while it does hands-on work (it's never a finished task).
      ...(running && coordinatorAtWork(liveToolFeed)
        ? [{ key: COORDINATOR_KEY, phase: "working" as const }]
        : []),
    ],
    [goalWorkers, running, liveToolFeed],
  );
  const [tallyState, setTallyState] = useState<{ source: string; tally: GoalTally }>({
    source: "",
    tally: EMPTY_TALLY,
  });
  useEffect(() => {
    setTallyState((prev) => {
      const base = prev.source === tallySource ? prev.tally : EMPTY_TALLY;
      const tally = tallyGoal(base, tallyInput);
      return prev.source === tallySource && tally === prev.tally
        ? prev
        : { source: tallySource, tally };
    });
  }, [tallySource, tallyInput]);
  const goalTally = useMemo(
    () =>
      !activeGoalId
        ? null
        : tallyState.source === tallySource
          ? tallyState.tally
          : tallyGoal(EMPTY_TALLY, tallyInput),
    [activeGoalId, tallyState, tallySource, tallyInput],
  );

  return {
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
  };
}
