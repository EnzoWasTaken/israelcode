import { useState } from "react";
import {
  setSessionRouting,
  type AgentState,
  type ModelOption,
  type RouteExecutionMode,
  type RoutePins,
} from "./agent";
import { RadioKeys } from "./RadioKeys";
import { modelDisplayName } from "./model-name";
import { effectiveStrategy, MODE_LABELS } from "./route-display";
import { thinkingLabel } from "./thinking-display";
import "./RouteControl.css";

const MODES: RouteExecutionMode[] = ["standard", "ultracode", "orchestrate"];

/**
 * Top of the model panel: Auto | Manual, the last decision's plain-words
 * explanation, and Model / Effort / Mode rows that read "Auto" or a pin.
 */
export function ModelRouting({
  state,
  models,
  onUltracodeChange,
  onOrchestrateChange,
}: {
  state: AgentState | null;
  models: readonly ModelOption[];
  /** Present only in code windows that support the modes. */
  onUltracodeChange?: (next: boolean) => void;
  onOrchestrateChange?: (next: boolean) => void;
}): React.ReactElement | null {
  const [error, setError] = useState<string | null>(null);
  const route = state?.autoRoute;
  const s = effectiveStrategy(state, models);
  const modesAvailable = Boolean(onUltracodeChange && onOrchestrateChange);
  const available = route?.available === true;
  const auto = s.auto;
  const d = auto ? (route?.lastDecision ?? null) : null;
  const fell = d !== null && (d.source === "fallback" || d.fallbackReason !== null);

  function send(opts: { enabled?: boolean; pins?: RoutePins }): void {
    setError(null);
    setSessionRouting(opts).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }
  function reset(dim: keyof RoutePins): void {
    const pins = { ...route?.pins };
    delete pins[dim];
    send({ pins });
  }
  function chooseMode(mode: RouteExecutionMode | "auto"): void {
    if (!auto) {
      onOrchestrateChange?.(mode === "orchestrate");
      onUltracodeChange?.(mode === "ultracode");
      return;
    }
    // Auto: a saved toggle acts as a pin in the router, so "Auto" must switch it off too.
    // Explicit choices pin via the router (applied per run, then restored) and leave the
    // saved default untouched, except a both-on legacy state, which is normalised off.
    if (mode === "auto") {
      reset("executionMode");
      if (state?.ultracode) onUltracodeChange?.(false);
      if (state?.orchestration?.orchestrate) onOrchestrateChange?.(false);
      return;
    }
    send({ pins: { ...route?.pins, executionMode: mode } });
    if (state?.ultracode && state.orchestration?.orchestrate) {
      onUltracodeChange?.(false);
      onOrchestrateChange?.(false);
    }
  }

  if (!route && !modesAvailable) return null;

  const row = (
    name: string,
    value: string,
    pinned: boolean,
    resetRow: () => void,
    source = "pinned",
  ) => (
    <div className="route-row" key={name}>
      <span className="route-row-name">{name}</span>
      <span className="route-row-value" data-pinned={pinned || undefined}>
        {pinned ? `${value} (${source})` : "Auto"}
      </span>
      {pinned && (
        <button
          type="button"
          className="key key-sm"
          aria-label={`Reset to Auto: ${name.toLowerCase()}`}
          onClick={resetRow}
        >
          Reset to Auto
        </button>
      )}
    </div>
  );

  return (
    <div className="route-section">
      {route && !available && (
        <p className="deck-note route-unavailable">
          Auto routing is unavailable here{route.reason ? `: ${route.reason}` : "."}
        </p>
      )}
      {available && (
        <RadioKeys
          label="Model selection"
          items={[
            { value: "auto", label: "Auto", checked: route?.enabled === true },
            { value: "manual", label: "Manual", checked: route?.enabled !== true },
          ]}
          onSelect={(v) => {
            const on = v === "auto";
            if (route?.enabled !== on) send({ enabled: on });
          }}
        />
      )}
      {error && (
        <p className="route-why" data-fallback role="alert">
          Couldn't change routing: {error}
        </p>
      )}
      {auto && (
        <>
          {d ? (
            <p className="route-why" data-fallback={fell || undefined}>
              {fell
                ? `Auto routing unavailable — using your current model${d.fallbackReason ? ` (${d.fallbackReason})` : ""}`
                : `${d.modelName}: ${d.explanation}`}
            </p>
          ) : (
            <p className="route-why">Auto picks the model, effort and mode for each prompt.</p>
          )}
          <div className="route-rows">
            {row(
              "Model",
              route?.pins.model ? modelDisplayName(models, route.pins.model.model) : "",
              s.pinned.model,
              () => reset("model"),
            )}
            {row("Effort", thinkingLabel(route?.pins.effort), s.pinned.effort, () =>
              reset("effort"),
            )}
            {modesAvailable &&
              row(
                "Mode",
                s.modeLabel,
                s.pinned.mode,
                () => chooseMode("auto"),
                s.modeSource === "toggle" ? "your setting" : "pinned",
              )}
          </div>
        </>
      )}
      {modesAvailable && (
        <RadioKeys
          label="Execution mode"
          items={(auto ? (["auto", ...MODES] as const) : MODES).map((mode) => ({
            value: mode,
            label: mode === "auto" ? "Auto" : MODE_LABELS[mode],
            checked:
              mode === "auto"
                ? !s.pinned.mode
                : s.modeLabel === MODE_LABELS[mode] && (!auto || s.pinned.mode),
          }))}
          onSelect={(v) => chooseMode(v as RouteExecutionMode | "auto")}
        />
      )}
    </div>
  );
}
