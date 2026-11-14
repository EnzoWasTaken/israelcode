// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckMenu, TitleBarActions, type GoalView } from "./WorkspaceHeaderActions";
import { EMPTY_TALLY, tallyGoal, type GoalTally } from "./goal-progress";
import type { WorkspaceMode } from "./agent";

vi.mock("./BackgroundSessions", () => ({
  BackgroundIndicator: () => <span data-testid="bg-indicator" />,
}));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Arrange</button> }));
// BudgetMeter reaches ./agent, whose module scope needs a Tauri window.
vi.mock("./BudgetMeter", () => ({ BudgetMeter: () => <span className="budget-pill" /> }));
// VerifyControl reaches ./agent too; keep a switch so the deck's wiring is testable.
vi.mock("./WorktreeReview", () => ({
  WorktreeReviewControl: () => <button>Review worktrees</button>,
}));
vi.mock("./VerifyControl", () => ({
  VerifyControl: ({
    verify,
    onChange,
  }: {
    verify: { enabled: boolean };
    onChange: (next: { enabled: boolean }) => void;
  }) => (
    <button
      role="switch"
      aria-checked={verify.enabled}
      onClick={() => onChange({ ...verify, enabled: !verify.enabled })}
    >
      Verify
    </button>
  ),
}));

function renderTitleBar(
  opts: {
    isGoal?: boolean;
    dirtyCount?: number;
    needsGitInit?: boolean;
    commitCommand?: string | null;
    running?: boolean;
    goalView?: GoalView | null;
    onGoalViewChange?: (view: GoalView) => void;
    goalNeedsAnswer?: boolean;
    goalTally?: GoalTally | null;
    goalState?: "running" | "paused" | "stopped";
    onPause?: (paused: boolean) => void;
    onCommit?: () => void;
  } = {},
): void {
  render(
    <TitleBarActions
      workspaceMode="code"
      isGoal={opts.isGoal ?? false}
      goalView={opts.goalView ?? null}
      onGoalViewChange={opts.onGoalViewChange ?? vi.fn()}
      goalNeedsAnswer={opts.goalNeedsAnswer ?? false}
      goalTally={opts.goalTally ?? null}
      goalState={opts.goalState}
      onGoalPauseChange={opts.onPause}
      xpChips={[]}
      running={opts.running ?? false}
      dirtyCount={opts.dirtyCount ?? 0}
      needsGitInit={opts.needsGitInit ?? false}
      onInitGit={vi.fn()}
      commitCommand={opts.commitCommand === undefined ? "commit" : opts.commitCommand}
      hasCommit
      onCommit={opts.onCommit ?? vi.fn()}
    />,
  );
}

function renderMenu(
  workspaceMode: WorkspaceMode,
  isGoal = false,
  verify?: { enabled: boolean; onChange: (next: unknown) => void },
): void {
  render(
    <DeckMenu
      workspaceMode={workspaceMode}
      isGoal={isGoal}
      running={false}
      autopilot={false}
      autopilotReviewing={false}
      onAutopilotChange={vi.fn()}
      verify={
        verify
          ? {
              enabled: verify.enabled,
              running: false,
              config: { commands: [], maxRounds: 3, source: "detected" },
            }
          : null
      }
      onVerifyChange={verify?.onChange}
      onNewSession={vi.fn()}
      onOpenNotes={vi.fn()}
      onOpenMemories={vi.fn()}
      projectTasks={[{ id: "t", title: "Open one", prompt: "", status: "pending", createdAt: "" }]}
      onOpenTasks={vi.fn()}
      showChecklist={false}
      onOpenChecklist={vi.fn()}
      onOpenRadio={vi.fn()}
      onOpenGoalSettings={isGoal ? vi.fn() : undefined}
      onArrange={vi.fn()}
      onBack={vi.fn()}
      backLabel="Back"
    />,
  );
}

afterEach(cleanup);

describe("TitleBarActions", () => {
  it("puts the uncommitted count inside the Commit key", () => {
    const onCommit = vi.fn();
    renderTitleBar({ dirtyCount: 17, onCommit });
    const commit = screen.getByRole("button", { name: "Commit 17 files" });
    expect(commit.textContent).toBe("Commit17");
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("says Clean instead of offering a commit with nothing to commit", () => {
    renderTitleBar({ dirtyCount: 0 });
    expect(screen.queryByRole("button", { name: /Commit/ })).toBeNull();
    expect(screen.getByText("Clean")).toBeDefined();
  });

  it("can't commit while the agent is working", () => {
    renderTitleBar({ dirtyCount: 2, running: true });
    expect(screen.getByRole("button", { name: "Commit 2 files" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("offers Initialize Git in a folder that isn't a repository", () => {
    renderTitleBar({ needsGitInit: true });
    expect(screen.getByRole("button", { name: "Initialize Git" })).toBeDefined();
  });

  it("has no view switch before the goal starts", () => {
    renderTitleBar({ isGoal: true });
    expect(screen.queryByRole("group", { name: "Goal view" })).toBeNull();
  });

  it("switches a started goal between Chat and Workers", () => {
    const onGoalViewChange = vi.fn();
    renderTitleBar({ isGoal: true, goalView: "chat", onGoalViewChange });
    const workers = screen.getByRole("button", { name: "Workers" });
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(workers);
    expect(onGoalViewChange).toHaveBeenCalledWith("workers");
  });

  it("flags Chat while a question waits there, but not when Chat is open", () => {
    renderTitleBar({ isGoal: true, goalView: "workers", goalNeedsAnswer: true });
    expect(
      screen.getByRole("button", { name: "Chat, a question is waiting for you" }),
    ).toBeDefined();
    cleanup();
    renderTitleBar({ isGoal: true, goalView: "chat", goalNeedsAnswer: true });
    expect(screen.getByRole("button", { name: "Chat" }).dataset.attention).toBeUndefined();
  });

  it("shows how many workers are working, and the tasks done and failed", () => {
    const tally = tallyGoal(EMPTY_TALLY, [
      { key: "a", phase: "working" },
      { key: "b", phase: "working" },
      { key: "c", phase: "done" },
    ]);
    renderTitleBar({ isGoal: true, goalView: "workers", goalTally: tally });
    expect(screen.getByRole("status", { name: "2 working · 1 done" }).textContent).toBe(
      "2 working1 done",
    );
    cleanup();
    // Failed tasks only show once there are any.
    const failed = tallyGoal(tally, [
      { key: "a", phase: "failed" },
      { key: "b", phase: "done" },
      { key: "c", phase: "done" },
    ]);
    renderTitleBar({ isGoal: true, goalView: "chat", goalTally: failed });
    expect(screen.getByRole("status", { name: "0 working · 2 done · 1 failed" })).toBeTruthy();
  });

  it("pauses a running goal and resumes a paused one", () => {
    const onPause = vi.fn();
    renderTitleBar({ isGoal: true, goalView: "chat", goalState: "running", onPause });
    fireEvent.click(screen.getByRole("button", { name: "Pause the goal" }));
    expect(onPause).toHaveBeenCalledWith(true);
    cleanup();
    renderTitleBar({ isGoal: true, goalView: "chat", goalState: "paused", onPause });
    fireEvent.click(screen.getByRole("button", { name: "Resume the goal" }));
    expect(onPause).toHaveBeenLastCalledWith(false);
  });
});

describe("DeckMenu", () => {
  it("holds the full project toolset in a code window", () => {
    renderMenu("code");
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    for (const label of [
      "New session",
      "Checklist",
      "Notes",
      "Tasks1",
      "Radio",
      "Arrange",
      "All projects",
    ]) {
      expect(labels).toContain(label);
    }
    expect(screen.getByRole("switch", { name: "Autopilot" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("leaves Ultracode and Orchestrate to the model control", () => {
    renderMenu("code");
    expect(screen.queryByRole("switch", { name: "Ultracode" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Orchestrate" })).toBeNull();
  });

  it("shows the Verify key in a coding deck only", () => {
    const onChange = vi.fn();
    renderMenu("code", false, { enabled: false, onChange });
    const key = screen.getByRole("switch", { name: "Verify" });
    expect(key.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(key);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    cleanup();
    renderMenu("chat", false, { enabled: true, onChange });
    expect(screen.queryByRole("switch", { name: "Verify" })).toBeNull();
  });

  it("offers Brain and New chat in a chat window, and no project tools", () => {
    renderMenu("chat");
    expect(screen.getByRole("button", { name: "Brain" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Checklist" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Autopilot" })).toBeNull();
  });

  it("keeps a Goal window to its settings, radio, layout and the way back", () => {
    renderMenu("code", true);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["All goals", "Goal settings", "Arrange", "Radio"]);
  });
});
