// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelPanel } from "./ModelPanel";
import { RouteControlLabel, RouteLine, routeControlName } from "./RouteControl";
import { setSessionRouting, type AgentState, type ModelOption } from "./agent";

vi.mock("./agent", () => ({
  setThinkingLevel: vi.fn(() => Promise.resolve()),
  setSessionRouting: vi.fn(() => Promise.resolve({})),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", provider: "anthropic" },
];
const DECISION = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  modelName: "Sonnet 5.5",
  effort: "medium",
  executionMode: "standard" as const,
  source: "router" as const,
  reason: "image",
  explanation: "Selected for image analysis",
  confidence: 0.9,
  fallbackReason: null,
  latencyMs: 10,
};

function mk(autoRoute: AgentState["autoRoute"], extra: Partial<AgentState> = {}): AgentState {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    thinkingLevel: "medium",
    supportedThinkingLevels: ["low", "medium", "high"],
    autoRoute,
    ...extra,
  } as AgentState;
}

function panel(state: AgentState, modes = true) {
  const onUltracodeChange = vi.fn();
  const onOrchestrateChange = vi.fn();
  render(
    <ModelPanel
      state={state}
      models={MODELS}
      modelsFailed={false}
      running={false}
      onSelectModel={vi.fn()}
      second={null}
      onUltracodeChange={modes ? onUltracodeChange : undefined}
      onOrchestrateChange={modes ? onOrchestrateChange : undefined}
      onClose={vi.fn()}
    />,
  );
  return { onUltracodeChange, onOrchestrateChange };
}

describe("model panel routing", () => {
  it("switches Auto and Manual through setSessionRouting", () => {
    panel(mk({ enabled: true, pins: {}, lastDecision: DECISION, available: true }));
    expect(screen.getByText("Sonnet 5.5: Selected for image analysis")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Manual" }));
    expect(setSessionRouting).toHaveBeenCalledWith({ enabled: false });
  });

  it("resets one pinned dimension and keeps the others", () => {
    panel(
      mk({
        enabled: true,
        pins: { effort: "high", model: { provider: "anthropic", model: "claude-sonnet-5-5" } },
        lastDecision: null,
        available: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset effort to Auto" }));
    expect(setSessionRouting).toHaveBeenCalledWith({
      pins: { model: { provider: "anthropic", model: "claude-sonnet-5-5" } },
    });
  });

  it("shows why Auto is unavailable and hides the switch", () => {
    panel(
      mk({
        enabled: false,
        pins: {},
        lastDecision: null,
        available: false,
        reason: "Motion windows use a fixed model",
      }),
      false,
    );
    expect(screen.getByText(/Motion windows use a fixed model/)).toBeDefined();
    expect(screen.queryByRole("radio", { name: "Auto" })).toBeNull();
  });

  it("wires the mode keys to the existing toggles", () => {
    const { onUltracodeChange, onOrchestrateChange } = panel(
      mk({ enabled: false, pins: {}, lastDecision: null, available: true }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Ultracode" }));
    expect(onUltracodeChange).toHaveBeenCalledWith(true);
    expect(onOrchestrateChange).toHaveBeenCalledWith(false);
  });

  it("explains a fallback plainly", () => {
    panel(
      mk({
        enabled: true,
        pins: {},
        lastDecision: { ...DECISION, source: "fallback", fallbackReason: "router timed out" },
        available: true,
      }),
    );
    expect(screen.getByText(/Auto routing unavailable — using your current model/)).toBeDefined();
  });
});

describe("route control and line", () => {
  const auto = mk({ enabled: true, pins: {}, lastDecision: DECISION, available: true });

  it("spells out the strategy in its accessible name", () => {
    expect(routeControlName(auto, MODELS)).toBe(
      "Model: Auto, currently Sonnet 5.5, effort medium, standard mode. Change",
    );
    expect(routeControlName(mk(undefined), MODELS)).toBe(
      "Model: manual, Sonnet 5.5, effort medium, standard mode. Change",
    );
  });

  it("tells Auto from manual at a glance", () => {
    render(<RouteControlLabel state={auto} models={MODELS} />);
    expect(screen.getByText("Auto")).toBeDefined();
    cleanup();
    render(<RouteControlLabel state={mk(undefined)} models={MODELS} />);
    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.getByText(/medium/)).toBeDefined();
  });

  it("renders the decision line and a fallback", () => {
    render(<RouteLine state={auto} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Sonnet 5.5 · Selected for image analysis",
    );
    cleanup();
    const fb = mk({
      enabled: true,
      pins: {},
      lastDecision: { ...DECISION, source: "fallback", fallbackReason: "router timed out" },
      available: true,
    });
    render(<RouteLine state={fb} />);
    const line = screen.getByRole("status");
    expect(line.textContent).toContain("router timed out");
    expect(line.getAttribute("data-fallback")).toBe("true");
  });
});

describe("execution mode semantics in Auto", () => {
  const auto = (pins = {}) => ({ enabled: true, pins, lastDecision: null, available: true });

  it("Standard pins the mode instead of only clearing toggles", () => {
    const { onUltracodeChange } = panel(mk(auto(), { ultracode: true }));
    fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
    expect(setSessionRouting).toHaveBeenCalledWith({ pins: { executionMode: "standard" } });
    expect(onUltracodeChange).not.toHaveBeenCalled();
  });

  it("Ultracode / Orchestrate pin and keep other pins", () => {
    panel(mk(auto({ effort: "high" })));
    fireEvent.click(screen.getByRole("radio", { name: "Orchestrate" }));
    expect(setSessionRouting).toHaveBeenCalledWith({
      pins: { effort: "high", executionMode: "orchestrate" },
    });
  });

  it("Auto clears the pin and turns an on toggle off", () => {
    const { onUltracodeChange, onOrchestrateChange } = panel(
      mk(auto({ executionMode: "ultracode" }), { ultracode: true }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Auto", checked: false }));
    expect(setSessionRouting).toHaveBeenCalledWith({ pins: {} });
    expect(onUltracodeChange).toHaveBeenCalledWith(false);
    expect(onOrchestrateChange).not.toHaveBeenCalled();
  });

  it("shows a saved toggle as pinned, not Auto", () => {
    panel(mk(auto(), { ultracode: true }));
    expect(screen.getByText("Ultracode (your setting)")).toBeDefined();
    expect(screen.getByRole("radio", { name: "Ultracode" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("shows a pin as pinned", () => {
    panel(mk(auto({ executionMode: "standard" })));
    expect(screen.getByText("Standard (pinned)")).toBeDefined();
  });

  it("both toggles on shows the combined label and any choice normalises", () => {
    const { onUltracodeChange, onOrchestrateChange } = panel(
      mk(auto(), { ultracode: true, orchestration: { orchestrate: true } as never }),
    );
    expect(screen.getByText("Ultracode + Orchestrate (your setting)")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Ultracode" }));
    expect(setSessionRouting).toHaveBeenCalledWith({ pins: { executionMode: "ultracode" } });
    expect(onUltracodeChange).toHaveBeenCalledWith(false);
    expect(onOrchestrateChange).toHaveBeenCalledWith(false);
  });

  it("Manual still drives the toggles", () => {
    const { onOrchestrateChange } = panel(
      mk({ enabled: false, pins: {}, lastDecision: null, available: true }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Orchestrate" }));
    expect(onOrchestrateChange).toHaveBeenCalledWith(true);
    expect(setSessionRouting).not.toHaveBeenCalled();
  });
});
