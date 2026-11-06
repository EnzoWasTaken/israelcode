// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_GREETING, BOOT_LINES, BootGate, BootScreen, bootAlreadySeen } from "./BootScreen";

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("BootScreen", () => {
  it("reveals the lines one by one, then the greeting, then calls onDone", () => {
    const onDone = vi.fn();
    const { container } = render(<BootScreen onDone={onDone} />);
    expect(container.querySelectorAll(".boot-line")).toHaveLength(0);
    advance(250);
    expect(container.querySelectorAll(".boot-line")).toHaveLength(1);
    for (let i = 1; i < BOOT_LINES.length; i++) advance(250);
    expect(container.querySelectorAll(".boot-line")).toHaveLength(BOOT_LINES.length);
    expect(screen.getByText(BOOT_GREETING)).toBeTruthy();
    advance(700);
    advance(400);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(bootAlreadySeen()).toBe(true);
  });

  it("skips straight out on any key", () => {
    const onDone = vi.fn();
    render(<BootScreen onDone={onDone} />);
    fireEvent.keyDown(window, { key: "x" });
    advance(400);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("skips on the button", () => {
    const onDone = vi.fn();
    render(<BootScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    advance(400);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("BootGate", () => {
  it("plays once per launch", () => {
    const first = render(<BootGate />);
    expect(first.container.querySelector(".boot-screen")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Enter" });
    advance(400);
    expect(first.container.querySelector(".boot-screen")).toBeNull();
    first.unmount();
    const second = render(<BootGate />);
    expect(second.container.querySelector(".boot-screen")).toBeNull();
  });
});
