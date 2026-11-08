// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Install native mocks before importing the real app. Keep its module loading in
// collection, outside the hook timeout: cold Windows imports can exceed 10s.
mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
// The markdown renderer and on-demand dialogs load lazily (the app warms them
// on idle); load them up front so a loaded machine cannot outrun findBy*.
await (await import("./LazyMarkdown")).preloadMarkdown();
await (await import("./lazy-surfaces")).preloadLazySurfaces();

beforeEach(() => {
  vi.useFakeTimers();
  mockWindows("main");
  // Keep native restoration pending: exercise the actual shell, without a daemon.
  mockIPC(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("placeholder work outside the composer", () => {
  it.each([true, false])("does not animate while restoring (focused=%s)", (focused) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    const interval = vi.spyOn(window, "setInterval");
    const view = render(<App />);
    expect(view.getByText("Restoring workspace…")).toBeTruthy();

    act(() => vi.advanceTimersByTime(12_500));
    const placeholderTimers = interval.mock.calls.filter(
      ([, delay]) => delay === 12_000 || delay === 24,
    );
    expect(placeholderTimers).toHaveLength(0);
  });
});
