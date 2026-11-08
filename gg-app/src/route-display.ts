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
  pinned: { model: boolean; effort: boolean; mode: boolean };
}

export const MODE_LABELS: Readonly<Record<RouteExecutionMode, string>> = {
  standard: "Standard",
  ultracode: "Ultracode",
  orchestrate: "Orchestrate",
};

/** What the next prompt will run with, in Auto or by hand. */
export function effectiveStrategy(state: AgentState | null, models: readonly ModelOption[]) {
  const route = state?.autoRoute;
  const auto = Boolean(route?.available && route.enabled);
  const decision = auto ? (route?.lastDecision ?? null) : null;
  const pins = auto ? (route?.pins ?? {}) : {};
  const stateMode: RouteExecutionMode = state?.ultracode
    ? "ultracode"
    : state?.orchestration?.orchestrate
      ? "orchestrate"
      : "standard";
  const strategy: Strategy = {
    auto,
    modelName:
      decision && !pins.model ? decision.modelName : modelDisplayName(models, state?.model),
    effort: pins.effort ?? (decision ? decision.effort : (state?.thinkingLevel ?? null)),
    mode: pins.executionMode ?? decision?.executionMode ?? stateMode,
    pinned: {
      model: Boolean(pins.model),
      effort: Boolean(pins.effort),
      mode: Boolean(pins.executionMode),
    },
  };
  return strategy;
}

/** "Model: Auto, currently Sonnet 5.5, effort medium, standard mode. Change" */
export function strategyAccessibleName(s: Strategy, hasEffort: boolean): string {
  const effort = hasEffort ? `, effort ${thinkingLabel(s.effort).toLowerCase()}` : "";
  return `Model: ${s.auto ? "Auto, currently" : "manual,"} ${s.modelName}${effort}, ${s.mode} mode. Change`;
}
