// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelPanel, type SecondAgent } from "./ModelPanel";
import type { AgentState, ModelOption } from "./agent";

vi.mock("./agent", () => ({ setThinkingLevel: vi.fn(() => Promise.resolve()) }));

// jsdom has no layout, so no `scrollIntoView` (same stub as Dropdown.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
  {
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    provider: "anthropic",
    billing: {
      label: "bills usage credits",
      detail: "Fast mode bills your Claude usage credits from the first token.",
      paid: true,
      standardModel: "claude-opus-5-5",
    },
  },
];

const STATE = { provider: "anthropic", model: "claude-opus-5-5" } as AgentState;

function renderPanel(second: SecondAgent | null = null, third?: SecondAgent | null) {
  const onSelectModel = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelPanel
      state={STATE}
      models={MODELS}
      modelsFailed={false}
      running={false}
      onSelectModel={onSelectModel}
      second={second}
      third={third}
      onClose={onClose}
    />,
  );
  return { onSelectModel, onClose };
}

function option(name: RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelPanel — a model that spends real money", () => {
  it("asks first, with Cancel as the default, and never switches on its own", () => {
    const { onSelectModel, onClose } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));

    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByText("Claude Opus 5.5 Fast spends real money.")).toBeTruthy();
    // Names what sessions fall back to, not a Claude-only "standard speed".
    expect(screen.getByText(/go back to Claude Opus 5\.5, and Israel/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    // Enter on the focused default answer backs out instead of paying.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Claude Opus 5.5 Fast spends real money.")).toBeNull();
  });

  it("backs out on Escape", () => {
    const { onSelectModel } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.queryByText("Claude Opus 5.5 Fast spends real money.")).toBeNull();
  });

  it("switches only after the explicit yes, and says so on the request", () => {
    const { onSelectModel, onClose } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));
    fireEvent.click(screen.getByRole("button", { name: "Use it and pay" }));
    expect(onSelectModel).toHaveBeenCalledWith("claude-opus-5-5-fast", { confirmPaid: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("switches a standard model straight away, with no confirmation", () => {
    const { onSelectModel } = renderPanel();
    fireEvent.click(option(/^Claude Opus 5\.5(?! Fast)/));
    expect(screen.queryByText(/spends real money/)).toBeNull();
    expect(onSelectModel).toHaveBeenCalledWith("claude-opus-5-5");
  });

  it("keeps it off Israel, who runs unwatched", () => {
    const onSelect = vi.fn();
    renderPanel({
      name: "Israel",
      followLabel: "Israel Code",
      model: "claude-opus-5-5",
      following: true,
      disabled: false,
      onSelect,
    });
    fireEvent.click(screen.getByRole("radio", { name: /^Israel(?! Code)/ }));
    const paid = option(/Claude Opus 5\.5 Fast/);
    expect(paid.getAttribute("aria-disabled")).toBe("true");
    expect(paid.textContent).toContain("main chat only");
    fireEvent.click(paid);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ModelPanel — the Workers (native orchestration)", () => {
  const workers = (
    onSelect: (id: string | null) => void,
    model = "claude-opus-5-5",
  ): SecondAgent => ({
    name: "Workers",
    followLabel: "Israel Code",
    model,
    following: model === "claude-opus-5-5",
    disabled: false,
    onSelect,
  });

  it("shows no Workers target when the window has none", () => {
    renderPanel();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio", { name: /Workers/ })).toBeNull();
  });

  it("adds a Workers target and pins the chosen model", () => {
    const onSelect = vi.fn();
    const { onSelectModel } = renderPanel(null, workers(onSelect));
    const key = screen.getByRole("radio", { name: /^Workers/ });
    expect(key.textContent).toContain("= Israel Code");
    fireEvent.click(key);
    expect(key.getAttribute("aria-checked")).toBe("true");
    expect(option(/^Follow Israel Code/)).toBeTruthy();
    fireEvent.click(option(/^Claude Opus 5\.5$/));
    expect(onSelect).toHaveBeenCalledWith("claude-opus-5-5");
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("clears the pin from the Follow row", () => {
    const onSelect = vi.fn();
    renderPanel(null, workers(onSelect, "claude-opus-5-5-fast"));
    fireEvent.click(screen.getByRole("radio", { name: /^Workers/ }));
    fireEvent.click(option(/^Follow Israel Code/));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("sits next to the second agent when both are given", () => {
    renderPanel(
      {
        name: "Israel",
        followLabel: "Israel Code",
        model: "claude-opus-5-5",
        following: true,
        disabled: false,
        onSelect: vi.fn(),
      },
      workers(vi.fn()),
    );
    expect(screen.getAllByRole("radio").map((r) => r.firstChild?.textContent)).toEqual([
      "Israel Code",
      "Israel",
      "Workers",
    ]);
  });
});
