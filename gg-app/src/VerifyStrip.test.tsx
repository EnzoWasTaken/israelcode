// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerifyStrip } from "./VerifyStrip";
import { verifyItemFromResult, type VerifyItem } from "./transcript-item";

afterEach(cleanup);

const running: VerifyItem = {
  kind: "verify",
  id: 1,
  maxRounds: 3,
  rounds: [
    {
      round: 1,
      checks: [
        { label: "test", command: "npm test", status: "fail", exitCode: 1, tail: "FAIL a.test" },
        { label: "lint", command: "eslint .", status: "running" },
      ],
    },
  ],
};

describe("VerifyStrip", () => {
  it("lists each check with its mark and exit code while the loop runs", () => {
    render(<VerifyStrip item={running} />);
    expect(screen.getByText("Round 1/3")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Verify" }).getAttribute("data-state")).toBe(
      "running",
    );
    expect(screen.queryByText(/All checks green|Still failing|Stopped/)).toBeNull();
  });

  it("keeps the failing output behind a disclosure", () => {
    render(<VerifyStrip item={running} />);
    const details = screen.getByText("Output").closest("details");
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain("FAIL a.test");
    // A running check has no output yet.
    expect(screen.getAllByText("Output")).toHaveLength(1);
  });

  it("says when every check went green", () => {
    const item = verifyItemFromResult(
      2,
      {
        passed: true,
        stoppedReason: "passed",
        rounds: [
          {
            round: 1,
            results: [{ label: "test", command: "t", exitCode: 1, durationMs: 1, tail: "x" }],
          },
          {
            round: 2,
            results: [{ label: "test", command: "t", exitCode: 0, durationMs: 1, tail: "" }],
          },
        ],
      },
      3,
    );
    render(<VerifyStrip item={item} />);
    expect(screen.getByText("All checks green on round 2")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Verify" }).getAttribute("data-state")).toBe("pass");
  });

  it("says when the cap was hit or the user stopped it", () => {
    const failed = verifyItemFromResult(3, {
      passed: false,
      stoppedReason: "max-rounds",
      rounds: [
        { round: 1, results: [{ label: "t", command: "t", exitCode: 1, durationMs: 1, tail: "" }] },
        { round: 2, results: [{ label: "t", command: "t", exitCode: 1, durationMs: 1, tail: "" }] },
      ],
    });
    render(<VerifyStrip item={failed} />);
    expect(screen.getByText("Still failing after 2 rounds")).toBeTruthy();
    cleanup();
    const stopped = verifyItemFromResult(4, {
      passed: false,
      stoppedReason: "cancelled",
      rounds: [
        {
          round: 1,
          results: [{ label: "t", command: "t", exitCode: null, durationMs: 1, tail: "" }],
        },
      ],
    });
    render(<VerifyStrip item={stopped} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByText("no exit code")).toBeTruthy();
  });
});
