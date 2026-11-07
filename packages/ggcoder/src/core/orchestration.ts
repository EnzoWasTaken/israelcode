import type { Message } from "@kenkaiiii/gg-ai";
import { ACTIVE_LIMIT } from "./subagent-manager.js";
import { ULTRACODE_ACTIVE_LIMIT } from "./ultracode.js";

/**
 * Native orchestration: the window's main model (the orchestrator) plans and
 * splits the work, hands each piece to a child on the Worker model, and reviews
 * every result before it replies. Like Ultracode it never touches the cached
 * system prompt: switching it on or off appends one hidden notice, and it
 * shares Ultracode's raised concurrent child cap while on.
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
): Message {
  const has = (name: string): boolean => toolNames.includes(name);
  const worker = workerModelName
    ? `the Worker model (${workerModelName})`
    : "the Worker model (currently the same model as you)";
  const lines = on
    ? [
        `${NOTICE_ON} You are the orchestrator: plan, delegate, review. Do not build the pieces yourself.`,
        "1. Plan: split the request into independent pieces with disjoint scopes (different files or modules), each with a clear done condition." +
          (has("todo_write")
            ? " Write the pieces down with `todo_write` and keep it current."
            : ""),
        has("spawn_agent")
          ? `2. Delegate: start one child per piece with \`spawn_agent\` (${ACTIVE_LIMIT} per call, up to ${ULTRACODE_ACTIVE_LIMIT} running at once). Each child runs on ${worker}; give it a complete brief: the goal, the exact files, the constraints, and how to verify. The children do the pieces, not you.`
          : `2. Delegate: this session has no \`spawn_agent\`, so work through the pieces one at a time, keeping each scope self-contained.`,
        "3. Review every worker's result before you reply: read the files it changed (the diff), run the project's checks yourself, and compare the result with the brief. If something is missing or wrong, send that worker a fix round with the exact findings and review again.",
        "4. Reply with one reviewed summary: what each worker did, what your review found (checks run, fixes requested), and what is left undone.",
        "Small or single-step requests stay direct; do not orchestrate those.",
      ]
    : [`${NOTICE_OFF} Work directly again; delegate only when it clearly helps.`];
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content: lines.join("\n") + "\nDo not restate this note; just proceed.",
  };
}
