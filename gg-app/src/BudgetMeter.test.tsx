// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BudgetMeter, formatTokens } from "./BudgetMeter";
import type { BudgetState } from "./agent";

const setBudget = vi.fn();
const budgetContinue = vi.fn();
vi.mock("./agent", () => ({
  setBudget: (...args: unknown[]) => setBudget(...args),
  budgetContinue: () => budgetContinue(),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

function state(overrides: Partial<BudgetState["status"]> = {}, hardStop = true): BudgetState {
  return {
    config: { hardStopOnRunaway: hardStop },
    status: {
      sessionUsed: 120_000,
      sessionCap: 200_000,
      dayUsed: 400_000,
      dayCap: null,
      level: "warn50",
      overridden: false,
      ...overrides,
    },
  };
}

afterEach(cleanup);

describe("BudgetMeter", () => {
  it("renders nothing without a cap", () => {
    const { container } = render(
      <BudgetMeter budget={state({ sessionCap: null, level: "ok" })} onChange={vi.fn()} />,
    );
    expect(container.querySelector(".budget-pill")).toBeNull();
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("shows used / cap in tokens with the level as tone and the day figure in the tooltip", () => {
    render(<BudgetMeter budget={state()} onChange={vi.fn()} />);
    const pill = screen.getByText("120k / 200k tokens");
    expect(pill.getAttribute("data-tone")).toBe("warn");
    expect(pill.getAttribute("title")).toBe("Today: 400k tokens, no day cap");
    cleanup();
    render(
      <BudgetMeter
        budget={state({ sessionUsed: 250_000, level: "exceeded" })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("250k / 200k tokens").getAttribute("data-tone")).toBe("exceeded");
  });

  it("saves a preset cap and the hard-stop switch through setBudget", async () => {
    const next = state({ sessionCap: 1_000_000 });
    setBudget.mockResolvedValue(next);
    const onChange = vi.fn();
    render(<BudgetMeter budget={state()} onChange={onChange} />);
    fireEvent.click(screen.getByText("120k / 200k tokens"));
    fireEvent.click(screen.getAllByRole("button", { name: "1M" })[0]!);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(next));
    expect(setBudget).toHaveBeenCalledWith({
      sessionTokens: 1_000_000,
      dayTokens: null,
      hardStopOnRunaway: false,
    });
  });

  it("offers Continue anyway once a cap is used up", async () => {
    const lifted = state({ sessionUsed: 250_000, level: "exceeded", overridden: true });
    budgetContinue.mockResolvedValue(lifted);
    const onChange = vi.fn();
    render(
      <BudgetMeter
        budget={state({ sessionUsed: 250_000, level: "exceeded" })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText("250k / 200k tokens"));
    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(lifted));
  });
});
