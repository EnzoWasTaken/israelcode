import type { AgentState, RouteExecutionMode } from "./agent";
import { modelDisplayName } from "./model-name";
import { thinkingLabel } from "./thinking-display";
import type { ModelOption } from "./agent";

export interface Strategy {
  /** Auto is on and available for this window. */
  auto: boolean;
  modelName: string;
  effort: string | null;
  mode: RouteExecutionMode;
  /** Display text for the mode ("Ultracode + Orchestrate" when both saved toggles are on). */
  modeLabel: string;
  /** Where a pinned mode comes from: the Auto pin, or the user's saved Ultracode/Orchestrate toggle. */
  modeSource: "pin" | "toggle" | null;
  pinned: { model: boolean; effort: boolean; mode: boolean };
}

export const MODE_LABELS: Readonly<Record<RouteExecutionMode, string>> = {
  standard: "Standard",
  ultracode: "Ultracode",
  orchestrate: "Orchestrate",
};

export const BOTH_LABEL = "Ultracode + Orchestrate";

/** What the next prompt will run with, in Auto or by hand. */
export function effectiveStrategy(state: AgentState | null, models: readonly ModelOption[]) {
  const route = state?.autoRoute;
  const auto = Boolean(route?.available && route.enabled);
  const decision = auto ? (route?.lastDecision ?? null) : null;
  const pins = auto ? (route?.pins ?? {}) : {};
  const ultra = Boolean(state?.ultracode);
  const orch = Boolean(state?.orchestration?.orchestrate);
  const both = ultra && orch;
  const stateMode: RouteExecutionMode = ultra ? "ultracode" : orch ? "orchestrate" : "standard";
  // The router treats a saved toggle exactly like a pin (buildRouteRequest), so show it as one.
  const modeSource: Strategy["modeSource"] = !auto
    ? null
    : pins.executionMode
      ? "pin"
      : stateMode !== "standard"
        ? "toggle"
        : null;
  const mode: RouteExecutionMode =
    pins.executionMode ?? (modeSource ? stateMode : (decision?.executionMode ?? stateMode));
  const strategy: Strategy = {
    auto,
    modelName:
      decision && !pins.model ? decision.modelName : modelDisplayName(models, state?.model),
    effort: pins.effort ?? (decision ? decision.effort : (state?.thinkingLevel ?? null)),
    mode,
    modeLabel: both && modeSource !== "pin" ? BOTH_LABEL : MODE_LABELS[mode],
    modeSource,
    pinned: {
      model: Boolean(pins.model),
      effort: Boolean(pins.effort),
      mode: modeSource !== null,
    },
  };
  return strategy;
}

/** "Model: Auto, currently Sonnet 5.5, effort medium, standard mode. Change" */
export function strategyAccessibleName(s: Strategy, hasEffort: boolean): string {
  const effort = hasEffort ? `, effort ${thinkingLabel(s.effort).toLowerCase()}` : "";
  return `Model: ${s.auto ? "Auto, currently" : "manual,"} ${s.modelName}${effort}, ${s.modeLabel.toLowerCase()} mode. Change`;
}
