// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { listHistory } from "./agent";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

afterEach(() => clearMocks());

it("rejects a failed transcript read instead of returning empty history", async () => {
  mockIPC((command) => {
    if (command === "agent_history") return Promise.reject(new Error("history unavailable"));
    return null;
  });
  await expect(listHistory()).rejects.toThrow("history unavailable");
});
