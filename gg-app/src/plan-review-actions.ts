import type { Dispatch, RefObject, SetStateAction } from "react";
import { acceptPlan as acceptPlanIPC, sendPrompt, type PromptMeta } from "./agent";
import { readChatError } from "./chat-error";
import type { PlanDecision } from "./PlanDecisionNotice";
import { countPlanSteps } from "./plan-steps";
import { nextId, type Item } from "./transcript-item";

/** Accept, revise or reject the plan in review. Extracted from App.tsx. */
export function createPlanReviewActions({
  planReview,
  setPlanReview,
  setPlanReviewAttempt,
  planReviewPathRef,
  pendingPlanTotalRef,
  pushItem,
  endStreamingText,
}: {
  planReview: string | null;
  setPlanReview: Dispatch<SetStateAction<string | null>>;
  setPlanReviewAttempt: Dispatch<SetStateAction<number>>;
  planReviewPathRef: RefObject<string | null>;
  pendingPlanTotalRef: RefObject<number | null>;
  pushItem: (item: Item) => void;
  endStreamingText: () => void;
}) {
  // ── Plan review actions (mirror the ggcoder CLI plan overlay) ──
  // Each closes the modal, drops a critter decision row, and drives the agent with
  // the corresponding instruction via the existing prompt path.
  //
  // The decision is always sent: the box only opens once the sidecar says the
  // plan is the user's, and a prompt landing during a run queues server-side.
  // (This used to bail silently on a stale `running` value, closing the box
  // and leaving the plan in limbo.)
  function runPlanPrompt(prompt: string, decision: PlanDecision, meta?: PromptMeta): void {
    setPlanReview(null);
    pushItem({ kind: "plan_decision", id: nextId(), decision });
    endStreamingText();
    void sendPrompt(prompt, [], meta).catch((error: unknown) => {
      reportPlanDecisionFailure("Your plan decision wasn't sent", error);
    });
  }

  function reportPlanDecisionFailure(headline: string, error: unknown): void {
    pushItem({
      kind: "error",
      id: nextId(),
      ...readChatError({
        headline,
        message: error instanceof Error ? error.message : String(error),
        guidance: "The plan is still waiting. Decide again once the agent is ready.",
      }),
    });
  }

  async function acceptPlan(): Promise<void> {
    // Capture the approved plan's step count BEFORE the IPC — accepting starts a
    // fresh session on the sidecar, whose session_reset broadcast nulls
    // planReview (and clears the transcript + counters) here.
    const reviewed = planReview;
    const nextPlanTotal = reviewed ? countPlanSteps(reviewed) : 0;
    // Stash a fallback for older sidecars. The current sidecar puts its canonical
    // live-file count directly on session_reset, which wins over this snapshot.
    pendingPlanTotalRef.current = nextPlanTotal;
    // Accept the plan: the sidecar wipes the planning conversation into a FRESH
    // session (so the build doesn't carry all the plan-mode research), bakes the
    // approved plan into the new system prompt, and broadcasts authoritative
    // progress before this request resolves. Do not re-seed from stale modal
    // content after the await: the plan file may already have changed.
    try {
      await acceptPlanIPC(planReviewPathRef.current);
    } catch (error) {
      // Refused (a run still finishing) or failed: sending "implement it now"
      // would run in the planning session without the approved plan. Say so
      // and re-open the box so Accept can be retried.
      pendingPlanTotalRef.current = null;
      reportPlanDecisionFailure("The plan couldn't be accepted", error);
      setPlanReview(reviewed);
      setPlanReviewAttempt((attempt) => attempt + 1);
      return;
    }
    runPlanPrompt(
      "The plan has been approved. Implement it now, following each step in order.",
      "accepted",
    );
  }

  function sendPlanFeedback(feedback: string): void {
    runPlanPrompt(
      `The plan was not approved. Feedback from the user:\n\n${feedback}\n\n` +
        "Revise the plan based on this feedback, then call exit_plan again for review.",
      "feedback",
      { planRevision: true },
    );
  }

  function rejectPlan(): void {
    runPlanPrompt(
      "The plan was rejected and dismissed. Do not implement it. Wait for new instructions.",
      "rejected",
    );
  }

  return { acceptPlan, sendPlanFeedback, rejectPlan };
}
