// @vitest-environment jsdom
// Every control on the main surfaces says what it does: a button or field
// with no accessible name is a mystery to screen readers and to tooltips.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GearSixIcon, KeyIcon } from "./phosphor-icons";
import { DeckMenu, TitleBarActions } from "./WorkspaceHeaderActions";
import { ProjectPicker } from "./ProjectPicker";
import { HomeScreen } from "./HomeScreen";
import { SettingsTabBar } from "./SettingsTabBar";
import { getSettings, hasModelSource, listProjects, waitForReady } from "./agent";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.0.0") }));
vi.mock("./AsciiLogo", () => ({ AsciiLogo: () => null }));
vi.mock("./HomeScenery", () => ({ HomeScenery: () => null, withScenery: (b: unknown) => b }));
vi.mock("./HomeCritters", () => ({ HomeCritters: () => null }));
vi.mock("./ScorecardModal", () => ({ ScorecardModal: () => null }));
vi.mock("./update", () => ({ useAppUpdate: () => ({ status: "idle" }) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./BackgroundSessions", () => ({
  BackgroundIndicator: () => null,
  BackgroundSection: () => null,
  isActive: () => false,
  listableRows: () => [],
  projectName: (p: string) => p,
  relativeTime: () => "",
  useBackgroundSessions: () => [],
}));
vi.mock("./BudgetMeter", () => ({ BudgetMeter: () => null }));
vi.mock("./WorktreeReview", () => ({ WorktreeReviewControl: () => null }));
vi.mock("./VerifyControl", () => ({ VerifyControl: () => null }));
vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectWorktrees", () => ({ ProjectWorktrees: () => null }));
vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  openUrl: vi.fn(),
  waitForReady: vi.fn(),
  getSettings: vi.fn(),
  hasModelSource: vi.fn(),
  openWhatsNewWindow: vi.fn(),
  getProgress: vi.fn(async () => null),
  setRemoteActive: vi.fn(),
  getServeStatus: vi.fn(async () => ({ running: false })),
  listProjects: vi.fn(),
  listSessions: vi.fn(async () => []),
  selectProject: vi.fn(),
  selectWorkspace: vi.fn(),
  setProjectHidden: vi.fn(),
  importTranscript: vi.fn(),
  getRadioState: vi.fn(async () => ({ stations: [], current: null, volume: 70 })),
  setRadio: vi.fn(),
  setRadioVolume: vi.fn(),
  setupWindows: vi.fn(),
}));

/** The name a screen reader announces, close enough for a regression check. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labelled = Array.from(el.labels ?? [])
      .map((l) => l.textContent ?? "")
      .join(" ")
      .trim();
    if (labelled) return labelled;
  } else {
    const text = el.textContent?.trim();
    if (text) return text;
  }
  return el.getAttribute("title")?.trim() ?? "";
}

function unnamedControls(): string[] {
  return Array.from(
    document.body.querySelectorAll(
      'button, [role="button"], [role="switch"], [role="tab"], input:not([type="hidden"]):not([type="file"]), textarea, select',
    ),
  )
    .filter((el) => !el.closest('[aria-hidden="true"]'))
    .filter((el) => accessibleName(el) === "")
    .map((el) => el.outerHTML.slice(0, 120));
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(waitForReady).mockResolvedValue();
  vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/dev", configured: true });
  vi.mocked(hasModelSource).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("accessible names on the main surfaces", () => {
  it("workspace header actions", () => {
    render(
      <TitleBarActions
        workspaceMode="code"
        isGoal={false}
        goalView={null}
        onGoalViewChange={vi.fn()}
        goalNeedsAnswer={false}
        goalTally={null}
        xpChips={[]}
        running={false}
        dirtyCount={3}
        needsGitInit={false}
        onInitGit={vi.fn()}
        commitCommand="commit"
        hasCommit
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(unnamedControls()).toEqual([]);
  });

  it("Deck menu", () => {
    render(
      <DeckMenu
        workspaceMode="code"
        isGoal={false}
        running={false}
        autopilot={false}
        autopilotReviewing={false}
        onAutopilotChange={vi.fn()}
        verify={null}
        onNewSession={vi.fn()}
        onOpenNotes={vi.fn()}
        onOpenMemories={vi.fn()}
        projectTasks={[]}
        onOpenTasks={vi.fn()}
        showChecklist={false}
        onOpenChecklist={vi.fn()}
        onOpenRadio={vi.fn()}
        onArrange={vi.fn()}
        onBack={vi.fn()}
        backLabel="Back"
      />,
    );
    expect(unnamedControls()).toEqual([]);
  });

  it("project picker", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { name: "ui-test", path: "/dev/ui-test", lastActiveDisplay: "1w ago", sources: ["ggcoder"] },
    ]);
    render(<ProjectPicker onChosen={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText("ui-test");
    expect(unnamedControls()).toEqual([]);
  });

  it("settings nav", () => {
    render(
      <SettingsTabBar
        tabs={[
          { id: "general", label: "General", icon: GearSixIcon },
          { id: "providers", label: "AI Providers", icon: KeyIcon },
        ]}
        selected="general"
        onSelect={vi.fn()}
        panelId="panel"
      />,
    );
    expect(unnamedControls()).toEqual([]);
  });

  it("home actions", async () => {
    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Code" });
    expect(unnamedControls()).toEqual([]);
  });
});
