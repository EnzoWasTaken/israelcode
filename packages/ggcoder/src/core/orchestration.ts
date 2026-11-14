import type { Message } from "@kenkaiiii/gg-ai";
import { ACTIVE_LIMIT } from "./subagent-manager.js";
import { ULTRACODE_ACTIVE_LIMIT } from "./ultracode.js";

/**
 * Native orchestration: the window's main model leads and hands the pieces to
 * children on the Worker model, following the method in the bundled `delegate`
 * skill (one spec, one build wave, one integrator, one review, capped fixes).
 * Like Ultracode it never touches the cached system prompt: switching it on or
 * off appends one hidden notice, and it shares Ultracode's raised child cap.
 */

/** A typed prompt asking to orchestrate just that prompt. */
export function hasOrchestrateKeyword(text: string): boolean {
  return /(^|[^\w-])orchestrate($|[^\w-])/i.test(text);
}

const NOTICE_ON = "Orchestrate is now ON.";
const NOTICE_OFF = "Orchestrate is now OFF.";

/** On/off when this message is an Orchestrate notice, else null. */
export function orchestrateNoticeState(m: Message | undefined): boolean | null {
  if (m?.role !== "user" || typeof m.content !== "string") return null;
  if (m.content.startsWith(NOTICE_ON)) return true;
  if (m.content.startsWith(NOTICE_OFF)) return false;
  return null;
}

/** What the newest Orchestrate notice in a history said (none = off). */
export function lastOrchestrateState(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const state = orchestrateNoticeState(messages[i]);
    if (state !== null) return state;
  }
  return false;
}

/**
 * The hidden notice for Orchestrate. `workerModelName` is the Worker model the
 * children run on; unset means they run on the orchestrator's own model.
 */
export function buildOrchestrateMessage(
  on: boolean,
  toolNames: readonly string[],
  workerModelName?: string,
  worktreeWorkers?: boolean,
): Message {
  const has = (name: string): boolean => toolNames.includes(name);
  const worker = workerModelName
    ? `the Worker model (${workerModelName})`
    : "the Worker model (currently the same model as you)";
  const spawn = has("spawn_agent");
  const method = has("skill")
    ? "First load the `delegate` skill with the `skill` tool and follow it as the lead."
    : "Method: write one spec (goal, files, constraints, how to verify) and keep each dispatch prompt short. Run one parallel build wave, then one integrator. Review the diff and evidence once yourself. Allow at most 2 fix rounds, each by a fresh worker; never send a follow-up to a finished worker. Workers report in a few lines.";
  const lines = on
    ? [
        `${NOTICE_ON} You are the lead: delegate, integrate, review. Do not build the pieces yourself.`,
        method,
        spawn
          ? `Workers are \`spawn_agent\` children (${ACTIVE_LIMIT} per call, up to ${ULTRACODE_ACTIVE_LIMIT} running at once) on ${worker}. Give each a complete brief: the goal, the exact files, the constraints, and how to verify.`
          : "This session has no `spawn_agent`, so work through the pieces one at a time, keeping each scope self-contained.",
        ...(worktreeWorkers && spawn
          ? [
              "Worktree workers are on: set isolation 'worktree' on every task that edits files, and review each worker's worktree diff (merge review) before merging it.",
            ]
          : []),
        "Small or single-step requests stay direct; do not orchestrate those.",
      ]
    : [`${NOTICE_OFF} Work directly again; delegate only when it clearly helps.`];
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content: lines.join("\n") + "\nDo not restate this note; just proceed.",
  };
}
