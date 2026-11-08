// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "./agent";

// Exercise the real app, navigation, modal, and storage; only the native boundary
// is mocked. Import after installing the window metadata, as in App.placeholder.
mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
// Deck tool bodies load on demand (warmed on idle in the app); load them up
// front so the deck opens synchronously, as it does once warmed.
await (await import("./lazy-surfaces")).preloadLazySurfaces();

// jsdom has no scrolling implementation; keep this browser-only API at the boundary.
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  if (scrollToDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
  clearMocks();
  localStorage.clear();
});

describe("session navigation notes", () => {
  it.each(["chat", "motion"] as const)(
    "%s opens, edits, reopens, and restores notes using the existing cwd key",
    async (mode) => {
      const cwd = `/workspaces/notes-${mode}`;
      const key = `gg-notes:${cwd}`;
      const saved = "Previously saved notes";
      const edited = `${mode} notes\nKeep this idea for later.`;
      const state: AgentState = {
        cwd,
        mode,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        running: false,
      };
      mockWindows("main");
      mockIPC((cmd) => {
        switch (cmd) {
          case "window_restore_target":
            return { mode, cwd, sessionPath: null };
          case "sidecar_port":
            return 12345;
          case "agent_state":
            return state;
          case "agent_models":
            return { models: [{ id: state.model, provider: state.provider }] };
          case "agent_commands":
            return { commands: [] };
          case "agent_tasks":
            return { tasks: [] };
          case "agent_history":
            return { history: [] };
          default:
            // Unrelated native subscriptions stay idle without a live daemon.
            return new Promise(() => {});
        }
      });
      localStorage.setItem(key, saved);
      localStorage.setItem("gg-notes:/workspaces/other", "Unrelated notes");

      const view = render(<App />);
      // Notes lives in the deck's ⋯ keypad and opens inside the window, over
      // the conversation, rather than as a pop-up dialog.
      const openNotes = async (): Promise<void> => {
        fireEvent.click(await screen.findByRole("button", { name: "More" }));
        expect(
          screen.getByRole("button", {
            name: mode === "chat" ? "Back to chats" : "Back to motion sessions",
          }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Notes" }));
        expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
      };
      await openNotes();
      await waitFor(() => {
        expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your notes" }).value).toBe(
          saved,
        );
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Your notes" }), {
        target: { value: edited },
      });
      expect(localStorage.getItem(key)).toBe(edited);
      expect(localStorage.getItem("gg-notes:/workspaces/other")).toBe("Unrelated notes");

      fireEvent.click(screen.getByRole("button", { name: "Close Notes" }));
      expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
      await openNotes();
      expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your notes" }).value).toBe(
        edited,
      );

      // Re-mount so an in-memory value alone cannot make persistence pass.
      view.unmount();
      render(<App />);
      await openNotes();
      await waitFor(() => {
        expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your notes" }).value).toBe(
          edited,
        );
      });
    },
  );
});
