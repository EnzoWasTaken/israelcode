// Ultracode's phases for one turn, read from the turn's own rows: its checklist
// (plan), its sub-agents (build), the `review…` child (verify) and the run's end
// (combine). Nothing extra is sent over the wire.
import type { SubAgentLine } from "./SubAgentFeed";
import type { Item as TranscriptItem } from "./transcript-item";

export type PhaseStatus = "pending" | "active" | "done";
export interface UltracodePhase {
  id: "plan" | "build" | "review" | "combine";
  label: string;
  status: PhaseStatus;
  detail?: string;
}

const FINISHED: ReadonlySet<SubAgentLine["status"]> = new Set([
  "done",
  "error",
  "interrupted",
  "idle",
]);
/** The reviewer child the Ultracode notice asks for (`task_name` "review…"). */
export const isReviewer = (agent: SubAgentLine): boolean =>
  /^(review|verif)/i.test(agent.agentName ?? "");

function groupStatus(agents: readonly SubAgentLine[]): PhaseStatus {
  if (agents.length === 0) return "pending";
  return agents.every((a) => FINISHED.has(a.status)) ? "done" : "active";
}

function doneCount(agents: readonly SubAgentLine[]): string {
  const done = agents.filter((a) => FINISHED.has(a.status)).length;
  const failed = agents.filter((a) => a.status === "error").length;
  return `${done}/${agents.length} done` + (failed ? `, ${failed} failed` : "");
}

/**
 * Phases for the rows of one Ultracode turn (everything after its user message).
 * Null when the run ended without fanning out: a small job handled directly.
 */
export function ultracodePhases(
  turn: readonly TranscriptItem[],
  running: boolean,
): UltracodePhase[] | null {
  const agents = turn.flatMap((it) => (it.kind === "subagent_group" ? it.agents : []));
  const hasPlan = turn.some((it) => it.kind === "todos");
  const reviewers = agents.filter(isReviewer);
  const builders = agents.filter((a) => !isReviewer(a));
  if (!running && agents.length === 0) return null;

  const build = groupStatus(builders);
  const review = groupStatus(reviewers);
  const plan: PhaseStatus = hasPlan || agents.length > 0 ? "done" : running ? "active" : "pending";
  const reviewSettled = review === "done" || (reviewers.length === 0 && build === "done");
  const combine: PhaseStatus =
    !running && agents.length > 0
      ? "done"
      : running && reviewSettled && build !== "active"
        ? "active"
        : "pending";
  return [
    { id: "plan", label: "Plan", status: plan },
    {
      id: "build",
      label: "Build",
      status: build,
      detail: builders.length
        ? `${builders.length} agent${builders.length === 1 ? "" : "s"}, ${doneCount(builders)}`
        : undefined,
    },
    {
      id: "review",
      label: "Review",
      status: review,
      detail: reviewers.length ? doneCount(reviewers) : undefined,
    },
    { id: "combine", label: "Combine", status: combine },
  ];
}

/** Each Ultracode or Orchestrate user message id → the rows of its turn. */
export function ultracodeTurns(items: readonly TranscriptItem[]): Map<number, TranscriptItem[]> {
  const turns = new Map<number, TranscriptItem[]>();
  let current: TranscriptItem[] | null = null;
  for (const it of items) {
    if (it.kind === "user" && !it.queued) {
      // Orchestrate turns share the strip: plan → build → review → combine.
      current = it.ultracode || it.orchestrate ? [] : null;
      if (current) turns.set(it.id, current);
    } else if (current) {
      current.push(it);
    }
  }
  return turns;
}
