// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  setWorktreeWorkers: vi.fn(),
  worktreeDiff: vi.fn(),
  worktreePreview: vi.fn(),
  worktreeVerify: vi.fn(),
  worktreeMerge: vi.fn(),
  worktreeDiscard: vi.fn(),
}));
vi.mock("./agent", () => calls);
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { WorktreeReview } from "./WorktreeReview";
import type { WorktreeWorkerRow } from "./agent";

afterEach(() => {
  cleanup();
  for (const fn of Object.values(calls)) fn.mockReset();
});

const worker: WorktreeWorkerRow = {
  agentId: "a1",
  name: "edit things",
  branch: "gg/worker/edit-1",
  path: "/t/w",
  base: "main",
  status: { dirty: 0, ahead: 1, changedFiles: 2 },
  childState: "completed",
};
const pref = { enabled: true, autoMerge: "never" as const };

describe("WorktreeReview", () => {
  it("lists workers and saves the auto-merge policy", async () => {
    const onChange = vi.fn();
    const next = { pref: { ...pref, autoMerge: "clean-and-verified" }, workers: [] };
    calls.setWorktreeWorkers.mockResolvedValue(next);
    render(
      <WorktreeReview
        state={{
          pref,
          workers: [
            {
              ...worker,
              autoMerge: { attempted: true, merged: false, reason: "Checks failed: test" },
            },
          ],
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("gg/worker/edit-1")).toBeTruthy();
    expect(screen.getByText(/2 files · 1 ahead · completed/)).toBeTruthy();
    expect(screen.getByText("Not auto-merged: Checks failed: test")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Auto-merge"), {
      target: { value: "clean-and-verified" },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(next));
    expect(calls.setWorktreeWorkers).toHaveBeenCalledWith({ autoMerge: "clean-and-verified" });
  });

  it("expands the diff with a truncated note", async () => {
    calls.worktreeDiff.mockResolvedValue({
      files: [{ path: "a.ts", status: "M", additions: 3, deletions: 1 }],
      patch: "diff --git a/a.ts",
      truncated: true,
    });
    render(<WorktreeReview state={{ pref, workers: [worker] }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Diff"));
    expect(await screen.findByText("diff --git a/a.ts")).toBeTruthy();
    expect(screen.getByText(/a\.ts \+3 −1/)).toBeTruthy();
    expect(screen.getByText(/Diff truncated/)).toBeTruthy();
  });

  it("disables Merge after conflicts are found, and while the worker runs", async () => {
    calls.worktreePreview.mockResolvedValue({ conflicts: ["a.ts"] });
    const { rerender } = render(
      <WorktreeReview state={{ pref, workers: [worker] }} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Check conflicts"));
    expect(await screen.findByText("Conflicts: a.ts")).toBeTruthy();
    expect((screen.getByText("Merge") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <WorktreeReview
        state={{ pref, workers: [{ ...worker, branch: "b2", childState: "running" }] }}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByText("Merge") as HTMLButtonElement).disabled).toBe(true);
  });

  it("merges only after the confirm step and shows streamed check rows", async () => {
    calls.worktreeMerge.mockResolvedValue({ merged: true, commit: "abc" });
    render(
      <WorktreeReview
        state={{ pref, workers: [worker] }}
        progress={{
          "gg/worker/edit-1": [
            { branch: "gg/worker/edit-1", label: "test", status: "failed", exitCode: 1 },
          ],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("test: failed (exit 1)")).toBeTruthy();
    fireEvent.click(screen.getByText("Merge"));
    expect(calls.worktreeMerge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm merge"));
    await waitFor(() =>
      expect(calls.worktreeMerge).toHaveBeenCalledWith("gg/worker/edit-1", "squash"),
    );
  });
});
