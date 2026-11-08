// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { normalizeBackgroundSessions } from "./agent";

describe("normalizeBackgroundSessions", () => {
  it("maps unknown status to idle and drops non-objects", () => {
    const rows = normalizeBackgroundSessions({
      sessions: [
        { id: "a", cwd: "/p", mode: "chat", title: "T", status: "weird", updatedAt: 5 },
        null,
        { id: null, sessionPath: "/s.jsonl", status: "awaiting_input", attached: true },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "a", mode: "chat", status: "idle", updatedAt: 5 });
    expect(rows[1]).toMatchObject({ status: "awaiting_input", attached: true, mode: "code" });
  });

  it("tolerates a malformed payload", () => {
    expect(normalizeBackgroundSessions(undefined)).toEqual([]);
    expect(normalizeBackgroundSessions({ sessions: "x" })).toEqual([]);
  });
});
