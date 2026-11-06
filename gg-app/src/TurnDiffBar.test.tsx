// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TurnFileDiff } from "./agent";

const revertTurnFiles = vi.hoisted(() => vi.fn());
vi.mock("./agent", () => ({ revertTurnFiles }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ toast }));
const { TurnDiffBar } = await import("./TurnDiffBar");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const files: TurnFileDiff[] = [
  {
    path: "src/a.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three",
  },
  { path: "new.txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hi" },
];

describe("TurnDiffBar", () => {
  it("sums the turn and expands a file to its diff", () => {
    render(<TurnDiffBar checkpointId="cp-0002" files={files} />);
    const summary = screen.getByRole("button", { name: /2 files changed/ });
    expect(summary.textContent).toContain("+3");
    expect(summary.textContent).toContain("\u22121");
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: /^src\/a\.ts/ }));
    expect(screen.getByText("+three").className).toBe("diff-add");
    expect(screen.getByText("-two").className).toBe("diff-del");
  });

  it("reverts one file, then the rest", async () => {
    revertTurnFiles.mockResolvedValue(1);
    render(<TurnDiffBar checkpointId="cp-0002" files={files} />);
    fireEvent.click(screen.getByRole("button", { name: /2 files changed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(screen.getByText("reverted")).toBeDefined());
    expect(revertTurnFiles).toHaveBeenCalledWith("cp-0002", ["new.txt"]);
    expect(screen.getByRole("button", { name: /1 file changed/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    await waitFor(() => expect(screen.getByText("All changes reverted")).toBeDefined());
    expect(revertTurnFiles).toHaveBeenLastCalledWith("cp-0002", ["src/a.ts"]);
  });

  it("explains a refused revert", async () => {
    revertTurnFiles.mockRejectedValue(
      new Error("Only the latest turn's changes can be reverted here."),
    );
    render(<TurnDiffBar checkpointId="cp-0001" files={files} />);
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("latest turn"), "error"),
    );
    expect(screen.getByRole("button", { name: /2 files changed/ })).toBeDefined();
  });
});
