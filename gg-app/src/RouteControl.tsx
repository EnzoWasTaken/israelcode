import type { AgentState, ModelOption } from "./agent";
import { effectiveStrategy, strategyAccessibleName } from "./route-display";
import { ThinkingDots, thinkingLabel } from "./thinking-display";
import "./RouteControl.css";

/** The rail's single model / effort / mode readout. Auto reads differently from manual. */
export function RouteControlLabel({
  state,
  models,
}: {
  state: AgentState | null;
  models: readonly ModelOption[];
}): React.ReactElement {
  const s = effectiveStrategy(state, models);
  const levels = state?.supportedThinkingLevels ?? [];
  return (
    <>
      <ThinkingDots levels={levels} level={s.effort} />
      {s.auto && <span className="route-auto">Auto</span>}
      {s.auto && (
        <span className="route-sep" aria-hidden="true">
          ·
        </span>
      )}
      <span className="well trunc">
        {s.modelName}
        {s.pinned.model && <PinMark />}
      </span>
      {!s.auto && levels.length > 0 && (
        <span className="route-effort" aria-hidden="true">
          · {thinkingLabel(s.effort).toLowerCase()}
        </span>
      )}
      {s.modeLabel !== "Standard" && (
        <span className="route-mode" aria-hidden="true">
          {s.modeLabel}
        </span>
      )}
    </>
  );
}

export function routeControlName(state: AgentState | null, models: readonly ModelOption[]): string {
  return strategyAccessibleName(
    effectiveStrategy(state, models),
    (state?.supportedThinkingLevels ?? []).length > 0,
  );
}

export function PinMark(): React.ReactElement {
  return (
    <span className="route-pin" title="Pinned" aria-hidden="true">
      {" "}
      ⌖
    </span>
  );
}

/** One quiet line for the status row: what Auto chose, or why it fell back. */
export function RouteLine({ state }: { state: AgentState | null }): React.ReactElement | null {
  const route = state?.autoRoute;
  const d = route?.lastDecision;
  if (!route?.available || !route.enabled || !d) return null;
  const fell = d.source === "fallback" || d.fallbackReason !== null;
  return (
    <span className="route-line" data-fallback={fell || undefined} role="status">
      <span>Auto</span> · {d.modelName}
      {d.explanation ? ` · ${d.explanation}` : ""}
      {fell && d.fallbackReason ? ` · ${d.fallbackReason}` : ""}
    </span>
  );
}
