import type { PermissionMode } from "./agent";

export type PillMode = PermissionMode | "plan";

/** Shift+Tab order, as in Claude Code. */
export const PILL_ORDER: readonly PillMode[] = ["ask", "accept-edits", "plan", "bypass"];

export const PILL_LABEL: Record<PillMode, string> = {
  ask: "Ask",
  "accept-edits": "Accept edits",
  plan: "Plan",
  bypass: "Bypass",
};

export const PILL_HINT: Record<PillMode, string> = {
  ask: "Edits and state-changing commands wait for your approval",
  "accept-edits": "Edits run; state-changing commands wait for your approval",
  plan: "Read and plan only; nothing is changed",
  bypass: "Everything runs without asking",
};

export function currentPill(
  mode: PermissionMode | undefined,
  planMode: boolean | undefined,
): PillMode {
  return planMode ? "plan" : (mode ?? "bypass");
}

export function nextPill(current: PillMode): PillMode {
  return PILL_ORDER[(PILL_ORDER.indexOf(current) + 1) % PILL_ORDER.length]!;
}
