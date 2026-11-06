// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "./agent";
import { currentPill, nextPill } from "./permission-mode";

afterEach(cleanup);

const bash: PendingApproval = {
  id: "a1",
  tool: "bash",
  command: "rm -rf dist",
  preview: "rm -rf dist",
  agentName: "cleanup",
  createdAt: 1,
};
const edit: PendingApproval = {
  id: "a2",
  tool: "edit",
  paths: ["src/a.ts"],
  preview: "--- src/a.ts\n- a\n+ b",
  createdAt: 2,
};

describe("ApprovalCard", () => {
  it("shows the oldest request and allows it once or always", () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard approvals={[bash, edit]} onAnswer={onAnswer} />);
    expect(screen.getByRole("alertdialog", { name: "Run this command?" })).toBeDefined();
    expect(screen.getByText("cleanup")).toBeDefined();
    expect(screen.getByText("1 of 2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onAnswer).toHaveBeenCalledWith("a1", "always");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onAnswer).toHaveBeenCalledWith("a1", "allow");
  });

  it("denies with a note, and offers no always-allow for edits", () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard approvals={[edit]} onAnswer={onAnswer} />);
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(screen.getByText(/\+ b/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Deny…" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep the old name" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledWith("a2", "deny", "keep the old name");
  });

  it("never takes focus from the composer when it appears", () => {
    render(<ApprovalCard approvals={[bash]} onAnswer={vi.fn()} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("permission pill", () => {
  it("cycles Ask → Accept edits → Plan → Bypass, with plan mode winning", () => {
    expect(currentPill(undefined, false)).toBe("bypass");
    expect(currentPill("ask", true)).toBe("plan");
    const seen = ["bypass"];
    for (let i = 0; i < 4; i++) seen.push(nextPill(seen[seen.length - 1] as "bypass"));
    expect(seen).toEqual(["bypass", "ask", "accept-edits", "plan", "bypass"]);
  });
});
