// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { error as logError } from "@tauri-apps/plugin-log";
import {
  getSettings,
  hasModelSource,
  importTranscript,
  listProjects,
  listSessions,
  selectProject,
  selectWorkspace,
  type RecentSession,
} from "./agent";
import { HomeScreen } from "./HomeScreen";
import { takeFirstPrompt } from "./first-prompt";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.0.0") }));
vi.mock("./AsciiLogo", () => ({ AsciiLogo: () => null }));
vi.mock("./HomeScenery", () => ({ HomeScenery: () => null, withScenery: (b: unknown) => b }));
vi.mock("./HomeCritters", () => ({ HomeCritters: () => null }));
vi.mock("./ScorecardModal", () => ({ ScorecardModal: () => null }));
vi.mock("./update", () => ({ useAppUpdate: () => ({ status: "idle" }) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  waitForReady: vi.fn(async () => undefined),
  getSettings: vi.fn(),
  hasModelSource: vi.fn(),
  openWhatsNewWindow: vi.fn(),
  getProgress: vi.fn(async () => null),
  setRemoteActive: vi.fn(),
  getServeStatus: vi.fn(async () => ({ running: false })),
  listProjects: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  selectProject: vi.fn(async () => undefined),
  selectWorkspace: vi.fn(async () => undefined),
  importTranscript: vi.fn(),
}));
vi.mock("./BackgroundSessions", () => ({
  BackgroundSection: () => null,
  isActive: () => false,
  listableRows: () => [],
  projectName: (p: string) => p.split("/").pop() ?? p,
  relativeTime: () => "4 min ago",
  useBackgroundSessions: () => [],
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  takeFirstPrompt();
});

const session = (
  path: string,
  ms: number | undefined,
  extra: Partial<RecentSession> = {},
): RecentSession => ({
  id: path,
  path,
  preview: `Title ${path}`,
  lastActiveDisplay: "earlier",
  messageCount: 3,
  ...(ms !== undefined ? { lastActiveMs: ms } : {}),
  ...extra,
});

/** Home set up (folder + provider), with one project and a chat. */
function setUp(): void {
  vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/root", configured: true });
  vi.mocked(hasModelSource).mockResolvedValue(true);
  vi.mocked(listProjects).mockResolvedValue([
    { name: "aurora", path: "/p/aurora", lastActiveDisplay: "", sources: [] },
  ]);
  vi.mocked(listSessions).mockImplementation(async (cwd) =>
    cwd === "/root"
      ? [session("/root/chat-1.jsonl", 200, { chatAgent: "research" })]
      : [session("/p/aurora/s1.jsonl", 300), session("/p/aurora/s2.jsonl", 100)],
  );
}

function renderHome(extra: Partial<React.ComponentProps<typeof HomeScreen>> = {}) {
  const props = {
    onProjects: vi.fn(),
    onGoals: vi.fn(),
    onChat: vi.fn(),
    onMotion: vi.fn(),
    onWorld: vi.fn(),
    onSettings: vi.fn(),
    onOpened: vi.fn(),
    ...extra,
  };
  render(<HomeScreen {...props} />);
  return props;
}

async function whenReady(): Promise<void> {
  const code = screen.getByRole("button", { name: "Code" });
  await waitFor(() => expect(code.getAttribute("aria-disabled")).toBeNull());
}

function prompt(): HTMLInputElement {
  return screen.getByRole("textbox", { name: /What are we building/ });
}

describe("HomeScreen", () => {
  it("logs a failed setup check instead of swallowing it", async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error("settings unreadable"));
    vi.mocked(hasModelSource).mockResolvedValue(false);

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

    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith("Home setup check failed: Error: settings unreadable"),
    );
    expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers Motion beside Code and Chat and opens it once set up", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(hasModelSource).mockResolvedValue(true);
    const onMotion = vi.fn();

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={onMotion}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const motion = screen.getByRole("button", { name: "Motion" });
    expect(screen.getByRole("button", { name: "Code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Chat" })).toBeDefined();
    await waitFor(() => expect(motion.getAttribute("aria-disabled")).toBeNull());

    fireEvent.click(motion);

    expect(onMotion).toHaveBeenCalledOnce();
  });

  it("orders the workspaces Code, Goals, Chat, Motion and opens Goals", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(hasModelSource).mockResolvedValue(true);
    const onGoals = vi.fn();

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={onGoals}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const names = ["Code", "Goals", "Chat", "Motion"];
    const buttons = names.map((name) => screen.getByRole("button", { name }));
    for (let i = 1; i < buttons.length; i++) {
      const prev = buttons[i - 1];
      const next = buttons[i];
      if (!prev || !next) throw new Error("missing workspace button");
      expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const goals = screen.getByRole("button", { name: "Goals" });
    await waitFor(() => expect(goals.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(goals);
    expect(onGoals).toHaveBeenCalledOnce();
  });

  it("shows the running version beside What's new, not in the update corner", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(hasModelSource).mockResolvedValue(false);

    const { container } = render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const version = await screen.findByText("v1.0.0");
    const row = version.closest(".home-version-row");
    expect(row?.classList.contains("is-pending")).toBe(false);
    expect(row?.querySelector("button")?.textContent).toBe("What's new");
    // With no update out, the top corner stays empty.
    expect(container.querySelector(".home-version-corner")?.childElementCount).toBe(0);
  });

  it("shows Goals with no Beta tag and leaves the byline to Settings", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(hasModelSource).mockResolvedValue(false);

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

    const goals = await screen.findByRole("button", { name: "Goals" });
    expect(goals.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.queryByText("In beta")).toBeNull();
    expect(screen.queryByText(/By Israel/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Skool" })).toBeNull();
    expect(screen.getByRole("button", { name: "Motion" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Code" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Chat" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  it("offers World after Motion, never dimmed, and enters it", async () => {
    // No folder and no provider: the workspace modes are dimmed, World isn't.
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "", configured: false });
    vi.mocked(hasModelSource).mockResolvedValue(false);
    const onWorld = vi.fn();
    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={onWorld}
        onSettings={vi.fn()}
      />,
    );
    const motion = screen.getByRole("button", { name: "Motion" });
    const world = screen.getByRole("button", { name: "World" });
    expect(motion.compareDocumentPosition(world) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(motion.getAttribute("aria-disabled")).toBe("true"));
    expect(world.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(world);
    await waitFor(() => expect(onWorld).toHaveBeenCalledOnce());
  });

  it("holds the World plate down from the click until World is on screen", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "", configured: false });
    vi.mocked(hasModelSource).mockResolvedValue(false);
    const props = {
      onProjects: vi.fn(),
      onGoals: vi.fn(),
      onChat: vi.fn(),
      onMotion: vi.fn(),
      onWorld: vi.fn(),
      onSettings: vi.fn(),
    };
    const { rerender } = render(<HomeScreen {...props} />);
    const world = screen.getByRole("button", { name: "World" });
    expect(world.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(world);
    await waitFor(() => expect(props.onWorld).toHaveBeenCalledOnce());
    expect(world.getAttribute("aria-busy")).toBe("true");
    rerender(<HomeScreen {...props} worldShown />);
    await waitFor(() => expect(world.getAttribute("aria-busy")).toBeNull());
  });
});

describe("HomeScreen quick start", () => {
  it("opens a new session in the chosen project and queues the text once", async () => {
    setUp();
    const props = renderHome();
    await whenReady();
    await screen.findByRole("button", { name: "Project: aurora" });
    fireEvent.change(prompt(), { target: { value: "  add dark mode  " } });
    fireEvent.submit(prompt().closest("form")!);
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith("code"));
    expect(selectProject).toHaveBeenCalledWith("/p/aurora");
    expect(takeFirstPrompt()).toBe("add dark mode");
    expect(takeFirstPrompt()).toBeNull();
  });

  it("opens a new chat when Chat is switched on", async () => {
    setUp();
    const props = renderHome();
    await whenReady();
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    fireEvent.change(prompt(), { target: { value: "hello" } });
    fireEvent.submit(prompt().closest("form")!);
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith("chat"));
    expect(selectWorkspace).toHaveBeenCalledWith("chat", "/root", undefined, "general");
    expect(takeFirstPrompt()).toBe("hello");
  });

  it("an empty submit just opens a new session", async () => {
    setUp();
    const props = renderHome();
    await whenReady();
    await screen.findByRole("button", { name: "Project: aurora" });
    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith("code"));
    expect(takeFirstPrompt()).toBeNull();
  });

  it("keeps the typed text and shows the error when opening fails", async () => {
    setUp();
    vi.mocked(selectProject).mockRejectedValueOnce(new Error("daemon is down"));
    const props = renderHome();
    await whenReady();
    await screen.findByRole("button", { name: "Project: aurora" });
    fireEvent.change(prompt(), { target: { value: "keep me" } });
    fireEvent.submit(prompt().closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("daemon is down");
    expect(prompt().value).toBe("keep me");
    expect(props.onOpened).not.toHaveBeenCalled();
    expect(takeFirstPrompt()).toBeNull();
  });
});

describe("HomeScreen jump back in", () => {
  it("lists the newest sessions across projects and chats, the first selected", async () => {
    setUp();
    renderHome();
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Title /p/aurora/s1.jsonl"),
      expect.stringContaining("Chat \u00b7 Research"),
      expect.stringContaining("Title /p/aurora/s2.jsonl"),
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter resumes the selected row; Down moves the selection", async () => {
    setUp();
    const props = renderHome();
    await whenReady();
    const list = await screen.findByRole("listbox", { name: "Jump back in" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith("chat"));
    expect(selectWorkspace).toHaveBeenCalledWith("chat", "/root", "/root/chat-1.jsonl", "research");
  });

  it("imports a Claude Code session before resuming it", async () => {
    setUp();
    vi.mocked(listSessions).mockImplementation(async (cwd) =>
      cwd === "/root" ? [] : [session("/cc/x.jsonl", 5, { source: "claude-code" })],
    );
    vi.mocked(importTranscript).mockResolvedValue({
      ok: true,
      sessionPath: "/p/aurora/new.jsonl",
    } as never);
    const props = renderHome();
    await whenReady();
    fireEvent.click(await screen.findByRole("option"));
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith("code"));
    expect(importTranscript).toHaveBeenCalledWith("/cc/x.jsonl", "/p/aurora");
    expect(selectProject).toHaveBeenCalledWith("/p/aurora", "/p/aurora/new.jsonl");
  });

  it("says what belongs there on first run", async () => {
    setUp();
    vi.mocked(listSessions).mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText(/press Enter to start your first session/)).toBeDefined();
  });
});

describe("HomeScreen mode keys", () => {
  it("1-5 open the modes, but not while typing", async () => {
    setUp();
    const props = renderHome();
    await whenReady();
    fireEvent.keyDown(prompt(), { key: "2" });
    expect(props.onGoals).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "2" });
    expect(props.onGoals).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: "5" });
    await waitFor(() => expect(props.onWorld).toHaveBeenCalledOnce());
  });
});
