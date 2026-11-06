import type { Message } from "@kenkaiiii/gg-ai";
import { ACTIVE_LIMIT } from "./subagent-manager.js";

/**
 * Ultracode: a provider-independent "go wide" mode for big jobs. It never
 * touches the cached system prompt; switching it on or off appends one hidden
 * notice (the same pattern as env-delta and plan notices) and raises the
 * concurrent child cap while it is on.
 */

/** Children that may run at once with Ultracode on (default is ACTIVE_LIMIT). */
export const ULTRACODE_ACTIVE_LIMIT = 12;

/** A typed prompt asking for Ultracode for just that prompt. */
export function hasUltracodeKeyword(text: string): boolean {
  return /(^|[^\w-])ultracode($|[^\w-])/i.test(text);
}

const NOTICE_ON = "Ultracode is now ON.";
const NOTICE_OFF = "Ultracode is now OFF.";

/** What the newest Ultracode notice in a history said (none = off). */
export function lastUltracodeState(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    if (m.content.startsWith(NOTICE_ON)) return true;
    if (m.content.startsWith(NOTICE_OFF)) return false;
  }
  return false;
}

export function buildUltracodeMessage(on: boolean, toolNames: readonly string[]): Message {
  const has = (name: string): boolean => toolNames.includes(name);
  const lines = on
    ? [
        `${NOTICE_ON} For substantial work, orchestrate instead of doing it all in one thread:`,
        "1. Plan the work as a few phases with disjoint scopes (different files or modules)." +
          (has("todo_write") ? " Track the phases with `todo_write`." : ""),
        has("spawn_agent")
          ? `2. Start one child per independent scope with \`spawn_agent\` (${ACTIVE_LIMIT} per call, up to ${ULTRACODE_ACTIVE_LIMIT} running at once); give each a complete brief, its files, and how to verify.`
          : "2. Work through the phases one at a time, keeping each scope self-contained.",
        has("spawn_agent")
          ? "3. Verify adversarially: once the work lands, start a separate read-only reviewer child to try to break it (tests, edge cases, the diff), and fix what it finds."
          : "3. Verify adversarially: re-read the diff as a skeptical reviewer, run the checks, and fix what you find.",
        "4. Synthesize: run the project's checks yourself and report one combined result.",
        "Small or single-step requests stay direct; do not fan out for them.",
      ]
    : [`${NOTICE_OFF} Work directly again; fan out only when it clearly helps.`];
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content: lines.join("\n") + "\nDo not restate this note; just proceed.",
  };
}
