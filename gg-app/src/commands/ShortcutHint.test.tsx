// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShortcutHint } from "./CommandCenter";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ShortcutHint", () => {
  it("shows once until dismissed, then stays quiet", () => {
    render(<ShortcutHint />);
    expect(screen.getByRole("note").textContent).toContain("Ctrl+K");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    render(<ShortcutHint />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: /commands/ })).toBeTruthy();
  });
});
