// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandCenter } from "./CommandCenter";
import { closeCommandSurface } from "./command-store";
import type { CommandHandlers } from "./command-registry";

vi.mock("../view-transition", () => ({
  withViewTransition: vi.fn((update: () => void) => update()),
}));

afterEach(() => {
  act(() => closeCommandSurface());
  cleanup();
  localStorage.clear();
});

function setup(extra: Partial<CommandHandlers> = {}) {
  const handlers = {
    toggleTheme: vi.fn(),
    openWhatsNew: vi.fn(),
    openSettings: vi.fn(),
    newWindow: vi.fn(),
    nextWindow: vi.fn(),
    prevWindow: vi.fn(),
    arrangeWindows: vi.fn(),
    ...extra,
  };
  const projects = vi.fn(async () => [
    { id: "project:/a", title: "alpha-app", section: "Projects" as const, run: vi.fn() },
  ]);
  render(
    <>
      <button type="button">opener</button>
      <CommandCenter
        handlers={handlers}
        loaders={[projects]}
        switchLoaders={[projects]}
        modelLoaders={[]}
      />
    </>,
  );
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  return { handlers, opener };
}

const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

describe("CommandPalette", () => {
  it("opens with Ctrl+K, closes with Escape and returns focus", () => {
    const { opener } = setup();
    press({ key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("filters with highlighted matches and runs the active row with Enter", () => {
    const { handlers, opener } = setup({ newSession: vi.fn() });
    press({ key: "k", metaKey: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "theme" } });
    const option = screen.getByRole("option", { selected: true });
    expect(option.textContent).toContain("Toggle light / dark theme");
    expect(option.querySelector("mark")?.textContent).toBe("theme");
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.toggleTheme).toHaveBeenCalledOnce();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("moves with arrows, Home and End and shows shortcuts", () => {
    setup({ newSession: vi.fn() });
    press({ key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    const options = () => screen.getAllByRole("option");
    const selected = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input, { key: "End" });
    expect(selected()).toBe(options().length - 1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toBe(options().length - 1);
    fireEvent.keyDown(input, { key: "Home" });
    expect(selected()).toBe(0);
    expect(options()[0]!.textContent).toBe("New session");
    const newWindow = options().find((o) => o.textContent?.startsWith("New window"))!;
    expect(newWindow.querySelectorAll("kbd")).toHaveLength(2);
  });

  it("offers only this screen's commands", () => {
    setup();
    press({ key: "k", ctrlKey: true });
    expect(screen.queryByRole("option", { name: /New session/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Settings: General/ })).toBeTruthy();
  });

  it("Ctrl+P lists only projects and sessions, loaded on open", async () => {
    setup();
    press({ key: "p", ctrlKey: true });
    expect(await screen.findByRole("option", { name: /alpha-app/ })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("runs a row on click", () => {
    const { handlers } = setup();
    press({ key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: /What's New/ }));
    expect(handlers.openWhatsNew).toHaveBeenCalledOnce();
  });
});

describe("ShortcutsSheet", () => {
  it("opens with Ctrl+/ and lists the registry's shortcuts, grouped", () => {
    const { opener } = setup();
    press({ key: "/", code: "Slash", ctrlKey: true });
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(sheet.textContent).toContain("Command palette");
    expect(sheet.textContent).toContain("Ctrl");
    expect(screen.getByRole("region", { name: "Composer" }).textContent).toContain("New line");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens from the palette action", () => {
    setup();
    press({ key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: /Keyboard shortcuts/ }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
