// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowOrder } from "./useWindowOrder";

vi.mock("./agent", () => ({
  onWindowOrder: vi.fn().mockResolvedValue(() => {}),
  windowLabel: "main",
}));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

/** A composer textarea; `shown` stands in for layout (jsdom has none). */
function composer(shown: boolean): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  document.body.append(el);
  const rects = shown ? [new DOMRect(0, 0, 100, 20)] : [];
  vi.spyOn(el, "getClientRects").mockReturnValue(
    Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList,
  );
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useWindowOrder focusing the composer", () => {
  it("puts the cursor back in the composer when the window is focused", () => {
    const el = composer(true);
    renderHook(() => useWindowOrder({ current: el }));
    window.dispatchEvent(new Event("focus"));
    expect(document.activeElement).toBe(el);
  });

  it("leaves a hidden composer alone (a goal's Workers view hides the chat)", () => {
    // Live bug: clicking the farm refocused the hidden box, and macOS drew
    // its caret marker over the farm where the box had been.
    const el = composer(false);
    renderHook(() => useWindowOrder({ current: el }));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.activeElement).not.toBe(el);
  });

  it("leaves a clicked button alone even when only its child is the target", () => {
    // Mac WebKit does not focus clicked buttons, so mouseup used to steal focus
    // and close a picker before its click ran.
    const el = composer(true);
    const button = document.createElement("button");
    const label = document.createElement("span");
    button.append(label);
    document.body.append(button);
    renderHook(() => useWindowOrder({ current: el }));
    label.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(document.activeElement).not.toBe(el);
  });

  it("leaves focus alone while a non-modal dialog is open", () => {
    const el = composer(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    renderHook(() => useWindowOrder({ current: el }));
    window.dispatchEvent(new Event("focus"));
    expect(document.activeElement).not.toBe(el);
  });

  it("still focuses the composer after a click on ordinary background", () => {
    const el = composer(true);
    const background = document.createElement("div");
    document.body.append(background);
    renderHook(() => useWindowOrder({ current: el }));
    background.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(document.activeElement).toBe(el);
  });
});
