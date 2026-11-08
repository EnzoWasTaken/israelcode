import { useEffect, useMemo, useState } from "react";
import type { TaskActivity } from "./task-activity";
import type { Item } from "./transcript-item";

/** The activity bar's run clock and its "your decision needed" override. */
export function useRunActivity({
  items,
  running,
  activity,
}: {
  items: Item[];
  running: boolean;
  activity: TaskActivity;
}) {
  // When the current run began, for the activity bar's timer. Kept here, not
  // in the bar: the bar lives in the chat, which the Workers view hides, and
  // its own clock would restart from zero each time the chat came back.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  // A question waiting in the transcript means the run is waiting on the user,
  // even when the window reopened after it was asked (the activity reducer
  // only sees the ask arrive live): say so instead of "Working...".
  const openQuestion = useMemo(
    () =>
      items.some((item) => item.kind === "ask" && !item.sent && !item.cancelled && !item.deferred),
    [items],
  );
  const barActivity = useMemo(
    () =>
      running && openQuestion && !activity.waitingForAnswer
        ? {
            ...activity,
            phase: "attention" as const,
            label: "Your decision needed",
            detail: "Answer the question in chat to continue.",
            waitingForAnswer: true,
            startedAt: activity.startedAt ?? runStartedAt,
          }
        : activity,
    [running, openQuestion, activity, runStartedAt],
  );
  useEffect(() => {
    setRunStartedAt((prev) => (running ? (prev ?? Date.now()) : null));
  }, [running]);

  return { runStartedAt, barActivity };
}
