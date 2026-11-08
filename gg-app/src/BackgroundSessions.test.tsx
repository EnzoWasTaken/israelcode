// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackgroundSessionRow } from "./agent";
import {
  BackgroundIndicator,
  BackgroundSection,
  BackgroundSessionList,
  activeSummary,
  describeStatus,
  listableRows,
  noteBackgroundHandoff,
  projectName,
  relativeTime,
} from "./BackgroundSessions";

const hooks = vi.hoisted(() => ({
  push: null as null | ((rows: unknown[]) => void),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./agent", () => ({
  listBackgroundSessions: vi.fn(async () => []),
  onBackgroundSessions: vi.fn((cb: (rows: unknown[]) => void) => {
    hooks.push = cb;
    return () => {};
  }),
  restoreTarget: vi.fn(async () => ({ sessionPath: "/own.jsonl" })),
  stopBackgroundSession: vi.fn(async () => {}),
  dismissBackgroundSession: vi.fn(async () => {}),
  deleteBackgroundSession: vi.fn(async () => {}),
}));
import * as agent from "./agent";
import { toast } from "./toast";

const row = (over: Partial<BackgroundSessionRow> = {}): BackgroundSessionRow => ({
  id: "s1",
  sessionPath: "/a.jsonl",
  cwd: "C:/code/my-app",
  mode: "code",
  chatAgent: null,
  title: "Fix login",
  status: "running",
  detail: null,
  attached: false,
  startedAt: 1,
  updatedAt: Date.now(),
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("helpers", () => {
  it("words each status plainly", () => {
    expect(
      describeStatus(row({ status: "awaiting_input", detail: "Waiting for your approval" })),
    ).toEqual({
      word: "Needs you",
      note: "Waiting for your approval",
    });
    expect(describeStatus(row({ status: "interrupted" })).note).toBe("Israel Code was closed");
    expect(describeStatus(row({ status: "cancelled" })).word).toBe("Stopped");
    expect(describeStatus(row({ status: "completed" })).word).toBe("Done");
    expect(describeStatus(row({ status: "failed", detail: "x".repeat(200) })).note).toHaveLength(
      90,
    );
  });
  it("names the project and time", () => {
    expect(projectName("C:/code/my-app/")).toBe("my-app");
    expect(relativeTime(0, 1000)).toBe("");
    expect(relativeTime(1000, 1000 + 5 * 60_000)).toBe("5 min ago");
  });
  it("lists urgent first and drops idle", () => {
    const rows = [
      row({ id: "a", status: "completed", updatedAt: 5 }),
      row({ id: "b", status: "idle" }),
      row({ id: "c", status: "running" }),
      row({ id: "d", status: "awaiting_input" }),
    ];
    expect(listableRows(rows).map((r) => r.id)).toEqual(["d", "c", "a"]);
    expect(activeSummary(rows)).toBe("1 needs you \u00b7 1 running");
    expect(activeSummary([row({ status: "completed" })])).toBeNull();
  });
});

describe("BackgroundSessionList", () => {
  it("offers Open and Stop task on a running row, and opens it", async () => {
    const onOpen = vi.fn();
    render(<BackgroundSessionList rows={[row()]} onOpen={onOpen} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Remove from list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Fix login" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: /Stop task/ }));
    await waitFor(() => expect(agent.stopBackgroundSession).toHaveBeenCalledWith("s1"));
  });

  it("falls back to the folder name and removes finished rows", async () => {
    render(
      <BackgroundSessionList rows={[row({ title: "", status: "completed" })]} onOpen={vi.fn()} />,
    );
    expect(screen.getAllByText("my-app").length).toBeGreaterThan(0);
    expect(screen.queryByText("Stop task")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remove from list/ }));
    await waitFor(() =>
      expect(agent.dismissBackgroundSession).toHaveBeenCalledWith({
        id: "s1",
        sessionPath: "/a.jsonl",
      }),
    );
  });

  it("confirms before deleting", async () => {
    render(<BackgroundSessionList rows={[row()]} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete conversation/ }));
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
    expect(agent.deleteBackgroundSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(agent.deleteBackgroundSession).toHaveBeenCalled());
  });

  it("shows rows held by another window without Open", () => {
    render(<BackgroundSessionList rows={[row({ attached: true })]} onOpen={vi.fn()} />);
    expect(screen.getByText("Open in another window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });

  it("hides this window's own row when asked", () => {
    const { container } = render(
      <BackgroundSessionList
        rows={[row({ attached: true })]}
        ownSessionPath="/a.jsonl"
        hideOwn
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector(".bgs-row")).toBeNull();
  });

  it("offers no Delete for rows attached to a window", () => {
    render(
      <BackgroundSessionList
        rows={[row({ attached: true }), row({ id: "s2", sessionPath: "/b.jsonl", attached: true })]}
        ownSessionPath="/a.jsonl"
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Delete conversation/ })).toBeNull();
  });

  it("offers no Delete in Settings (no own path) for attached rows", () => {
    render(
      <BackgroundSessionList rows={[row({ attached: true })]} onOpen={vi.fn()} canOpen={false} />,
    );
    expect(screen.queryByRole("button", { name: /Delete conversation/ })).toBeNull();
  });

  it("toasts the daemon's refusal to delete", async () => {
    vi.mocked(agent.deleteBackgroundSession).mockRejectedValueOnce(
      new Error("409: in use by a window"),
    );
    render(<BackgroundSessionList rows={[row()]} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete conversation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't delete it: 409: in use by a window", "error"),
    );
  });

  it("reports a failed action", async () => {
    vi.mocked(agent.stopBackgroundSession).mockRejectedValueOnce(new Error("nope"));
    render(<BackgroundSessionList rows={[row()]} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Stop task/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't stop it: nope", "error"));
  });
});

describe("BackgroundIndicator", () => {
  it("is absent until another session is running, then opens the list", async () => {
    render(<BackgroundIndicator onOpen={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => hooks.push?.([]));
    await act(async () =>
      hooks.push?.([
        { ...row({ id: "own", sessionPath: "/own.jsonl" }) },
        row({
          id: "x",
          sessionPath: "/x.jsonl",
          status: "awaiting_input",
          detail: "Waiting for your approval",
        }),
      ]),
    );
    const button = await screen.findByRole("button", { name: /1 needs you/ });
    fireEvent.click(button);
    expect(await screen.findByText("Waiting for your approval")).toBeTruthy();
  });
});

describe("BackgroundSection", () => {
  it("renders nothing when empty and lists interrupted rows", async () => {
    const { container } = render(<BackgroundSection onOpen={vi.fn()} />);
    expect(container.querySelector(".bgs-section")).toBeNull();
    await act(async () => hooks.push?.([row({ status: "interrupted" })]));
    expect(await screen.findByText("Israel Code was closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Open / })).toBeTruthy();
  });
});

describe("noteBackgroundHandoff", () => {
  it("toasts only the first time", () => {
    noteBackgroundHandoff();
    noteBackgroundHandoff();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Still running in the background. Find it under Background.",
      "info",
    );
  });
});
