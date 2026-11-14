// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  setCompaction: vi.fn(),
  compactNow: vi.fn(),
  undoCompaction: vi.fn(),
}));
vi.mock("./agent", () => ({
  setCompaction: calls.setCompaction,
  compactNow: calls.compactNow,
  undoCompaction: calls.undoCompaction,
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { CompactionControl, formatUsage, parsePins } from "./CompactionControl";
import type { CompactionState } from "./agent";

afterEach(() => {
  cleanup();
  calls.setCompaction.mockReset();
  calls.compactNow.mockReset();
  calls.undoCompaction.mockReset();
});

const state: CompactionState = {
  pref: { pins: ["keep the API"] },
  info: {
    threshold: 0.85,
    atTokens: 400_000,
    contextWindow: 200_000,
    activeTokens: 84_000,
    lastCompactionRewindId: null,
  },
};

function open(s = state, running = false) {
  const onChange = vi.fn();
  render(
    <CompactionControl compaction={s} contextPct={42} running={running} onChange={onChange} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Context 42% used. Compaction" }));
  return onChange;
}

describe("CompactionControl helpers", () => {
  it("formats the usage line and reads pins one per line, capped at 20", () => {
    expect(formatUsage(42, 200_000)).toBe("42% of 200k");
    expect(parsePins(" a \n\nb\n")).toEqual(["a", "b"]);
    expect(parsePins(Array.from({ length: 25 }, (_, i) => `p${i}`).join("\n"))).toHaveLength(20);
  });
});

describe("CompactionControl", () => {
  it("shows the usage and saves a threshold preset", async () => {
    calls.setCompaction.mockResolvedValue({ ...state, pref: { ...state.pref, threshold: 0.7 } });
    const onChange = open();
    expect(screen.getByRole("dialog", { name: "Context" }).textContent).toContain("42% of 200k");
    expect(screen.getByRole("button", { name: "85%" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "70%" }));
    await waitFor(() => expect(calls.setCompaction).toHaveBeenCalledWith({ threshold: 0.7 }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ pref: expect.objectContaining({ threshold: 0.7 }) }),
      ),
    );
  });

  it("saves the pins after a pause and the token count on blur", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      calls.setCompaction.mockResolvedValue(state);
      open();
      const pins = screen.getByLabelText(/Keep verbatim/);
      expect((pins as HTMLTextAreaElement).value).toBe("keep the API");
      fireEvent.change(pins, { target: { value: "keep the API\nuse pnpm" } });
      expect(calls.setCompaction).not.toHaveBeenCalled();
      vi.advanceTimersByTime(700);
      await waitFor(() =>
        expect(calls.setCompaction).toHaveBeenCalledWith({ pins: ["keep the API", "use pnpm"] }),
      );
      const tokens = screen.getByLabelText("or at tokens");
      fireEvent.change(tokens, { target: { value: "150000" } });
      fireEvent.blur(tokens);
      await waitFor(() => expect(calls.setCompaction).toHaveBeenCalledWith({ atTokens: 150_000 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("compacts now, and disables both actions while a run is active", async () => {
    calls.compactNow.mockResolvedValue({ compacted: true, originalCount: 40, newCount: 3 });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(calls.compactNow).toHaveBeenCalledOnce());
    cleanup();
    open(state, true);
    expect(
      (screen.getByRole("button", { name: "Compact now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Undo last compaction" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("undoes the last compaction only when there is one", async () => {
    open();
    expect(
      (screen.getByRole("button", { name: "Undo last compaction" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    calls.undoCompaction.mockResolvedValue({ restoredCount: 40, newCount: 3 });
    open({
      ...state,
      info: { ...state.info, lastCompactionRewindId: "cp-4", lastCompactionAt: 1 },
    });
    const undo = screen.getByRole("button", { name: "Undo last compaction" });
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(calls.undoCompaction).toHaveBeenCalledOnce());
  });
});
