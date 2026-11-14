// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getSettings,
  importTranscript,
  listBackgroundSessions,
  listProjects,
  listSessions,
  newWindow,
  selectProject,
  setProjectHidden,
  waitForReady,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { ProjectPicker } from "./ProjectPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  listBackgroundSessions: vi.fn(() => Promise.resolve([])),
  newWindow: vi.fn(() => Promise.resolve()),
  onBackgroundSessions: vi.fn(() => () => undefined),
  getSettings: vi.fn(),
  importTranscript: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  selectProject: vi.fn(),
  setProjectHidden: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));
vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectWorktrees", () => ({ ProjectWorktrees: () => null }));

const getSettingsMock = vi.mocked(getSettings);
const importTranscriptMock = vi.mocked(importTranscript);
const listProjectsMock = vi.mocked(listProjects);
const listSessionsMock = vi.mocked(listSessions);
const selectProjectMock = vi.mocked(selectProject);
const setProjectHiddenMock = vi.mocked(setProjectHidden);
const waitForReadyMock = vi.mocked(waitForReady);

const PROJECT: DiscoveredProject = {
  name: "ui-test",
  path: "/Users/dev/ui-test",
  lastActiveDisplay: "1w ago",
  sources: ["claude-code"],
};

const NATIVE_SESSION: RecentSession = {
  id: "gg-1",
  path: "/sessions/gg-1.jsonl",
  preview: "Native Israel Code session",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
};

const FOREIGN_SESSION: RecentSession = {
  id: "cc-1",
  path: "/Users/dev/.claude/projects/-Users-dev-ui-test/cc-1.jsonl",
  preview: "Build a UI dashboard in HTML",
  lastActiveDisplay: "1w ago",
  messageCount: 44,
  source: "claude-code",
};

/** Render the picker already opened on the project's session list. */
async function renderSessionList(sessions: RecentSession[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue([PROJECT]);
  listSessionsMock.mockResolvedValue(sessions);
  selectProjectMock.mockResolvedValue();

  render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);
  await screen.findByText(sessions[0]!.preview);
}

// Pickers keep their last list per window (useCachedList); each test starts
// from a first visit.
beforeEach(() => sessionStorage.clear());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OTHER_PROJECT: DiscoveredProject = {
  name: "scratch",
  path: "/private/tmp",
  lastActiveDisplay: "1d ago",
  sources: ["ggcoder"],
};

/** Render the picker on the project list (no deep link). */
async function renderProjectList(projects: DiscoveredProject[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue(projects);

  render(<ProjectPicker onChosen={vi.fn()} />);
  await screen.findByText(projects[0]!.name);
}

describe("ProjectPicker hide", () => {
  it("removes the row and persists the decision", async () => {
    setProjectHiddenMock.mockResolvedValue();
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide scratch from this list"));

    await waitFor(() => expect(screen.queryByText("scratch")).toBeNull());
    expect(setProjectHiddenMock).toHaveBeenCalledWith("/private/tmp", true);
    // The untouched project stays put.
    expect(screen.getByText("ui-test")).toBeTruthy();
  });

  it("restores the row in place when persisting fails", async () => {
    setProjectHiddenMock.mockRejectedValue(new Error("disk full"));
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide ui-test from this list"));

    // Comes back rather than lying about what the next launch will show, and
    // returns to its original position rather than the end of the list.
    await waitFor(() => expect(screen.getByText("ui-test")).toBeTruthy());
    const names = screen.getAllByText(/^(ui-test|scratch)$/).map((n) => n.textContent);
    expect(names).toEqual(["ui-test", "scratch"]);
  });
});

describe("ProjectPicker load failures", () => {
  it("says the project list failed to load and retries, not 'No projects yet'", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockRejectedValueOnce(new Error("daemon down")).mockResolvedValue([PROJECT]);

    render(<ProjectPicker onChosen={vi.fn()} />);

    expect(await screen.findByText("Couldn't load your projects.")).toBeTruthy();
    expect(screen.queryByText(/No projects yet/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(PROJECT.name)).toBeTruthy();
    expect(screen.queryByText("Couldn't load your projects.")).toBeNull();
  });

  it("says a project's sessions failed to load instead of an endless skeleton", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([PROJECT]);
    listSessionsMock.mockRejectedValueOnce(new Error("daemon down"));

    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);

    expect(await screen.findByText("Couldn't load this project's sessions.")).toBeTruthy();
    expect(screen.queryByText("No previous sessions yet.")).toBeNull();
    expect(document.querySelector(".list-skeleton")).toBeNull();

    listSessionsMock.mockResolvedValue([NATIVE_SESSION]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(NATIVE_SESSION.preview)).toBeTruthy();
  });
});

describe("ProjectPicker session list", () => {
  it("badges a Claude Code session with its source", async () => {
    await renderSessionList([NATIVE_SESSION, FOREIGN_SESSION]);

    // The foreign row is labelled; the native one carries no source tag.
    const foreignRow = screen.getByText(FOREIGN_SESSION.preview).closest("[role=option]");
    const badge = foreignRow?.querySelector(".sb-row-source");
    expect(badge?.textContent).toBe("Claude Code");
    expect(foreignRow?.getAttribute("title")).toContain("opens as an Israel Code session");

    const nativeRow = screen.getByText(NATIVE_SESSION.preview).closest("[role=option]");
    expect(nativeRow?.textContent).not.toContain("Claude Code");
    expect(nativeRow?.querySelector(".sb-row-source")).toBeNull();
    expect(nativeRow?.getAttribute("title")).toBe(NATIVE_SESSION.preview);
  });

  it("imports then opens when a foreign session is clicked", async () => {
    importTranscriptMock.mockResolvedValue({
      ok: true,
      sessionId: "imported-1",
      sessionPath: "/sessions/imported-1.jsonl",
      cwd: PROJECT.path,
      format: "claude",
      messageCount: 44,
      dropped: "nothing",
    });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    await waitFor(() => {
      // Imported from the foreign transcript...
      expect(importTranscriptMock).toHaveBeenCalledWith(FOREIGN_SESSION.path, PROJECT.path);
      // ...then opened by the NEW session path, not the transcript path.
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, "/sessions/imported-1.jsonl");
    });
  });

  it("opens a native session directly, with no import", async () => {
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

    await waitFor(() => {
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, NATIVE_SESSION.path);
    });
    expect(importTranscriptMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed import instead of opening a broken session", async () => {
    importTranscriptMock.mockResolvedValue({ ok: false, error: "Could not read transcript" });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Could not read transcript");
    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("stays usable after a failed import", async () => {
    importTranscriptMock.mockRejectedValue(new Error("daemon not ready"));
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));
    await screen.findByRole("alert");

    // `busy` must be released, or every later click is silently ignored.
    const row = screen.getByText(FOREIGN_SESSION.preview).closest("[role=option]");
    expect(row?.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("ProjectPicker returning from a session", () => {
  it("opens straight on the project's sessions, never flashing the project list", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    // Discovery hasn't answered yet: the first paint is all there is.
    waitForReadyMock.mockReturnValue(new Promise(() => {}));
    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);
    expect(screen.getByText("ui-test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New session" })).toBeTruthy();
    expect(screen.queryByText("Choose a project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open existing" })).toBeNull();
  });

  it("falls back to the project list when the path isn't a known project", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([OTHER_PROJECT]);
    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath="/Users/dev/gone" />);
    expect(await screen.findByText("Choose a project")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open existing" }).length).toBeGreaterThan(0);
  });
});

describe("ProjectPicker search keys and empty states", () => {
  it("offers next steps when the search matches nothing, and Clear search resets it", async () => {
    await renderProjectList([PROJECT, OTHER_PROJECT]);
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(/No projects match/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open existing" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "+ New project" }).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("scratch")).toBeTruthy();
  });

  it("opens the top match on Enter", async () => {
    listSessionsMock.mockResolvedValue([]);
    await renderProjectList([PROJECT, OTHER_PROJECT]);
    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "scr" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByText("No previous sessions yet.")).toBeTruthy();
    expect(screen.getByText("scratch")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search projects" })).toBeNull();
  });

  it("clears the search on Escape without letting the key go Back", async () => {
    await renderProjectList([PROJECT, OTHER_PROJECT]);
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    try {
      const search = screen.getByRole<HTMLInputElement>("textbox", { name: "Search projects" });
      fireEvent.change(search, { target: { value: "scr" } });
      fireEvent.keyDown(search, { key: "Escape" });
      expect(search.value).toBe("");
      expect(outer).not.toHaveBeenCalled();
      // Nothing left to clear: Escape carries on to the window as before.
      fireEvent.keyDown(search, { key: "Escape" });
      expect(outer).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("fills a short list with a hint to open a missing project", async () => {
    await renderProjectList([PROJECT]);
    expect(screen.getByText(/Missing a project\?/)).toBeTruthy();
  });
});

describe("ProjectPicker session browser", () => {
  const HOUR = 3_600_000;
  const rows: RecentSession[] = [
    {
      ...NATIVE_SESSION,
      id: "a",
      path: "/s/a.jsonl",
      preview: "Fix the cart test",
      lastActiveMs: Date.now() - 60_000,
    },
    {
      ...NATIVE_SESSION,
      id: "b",
      path: "/s/b.jsonl",
      preview: "Write API docs",
      lastActiveMs: Date.now() - 30 * 24 * HOUR,
    },
    { ...FOREIGN_SESSION, lastActiveMs: Date.now() - 40 * 24 * HOUR },
  ];
  const selectedTitle = (): string | null | undefined =>
    document.querySelector("[role=option][aria-selected=true] .sb-row-title")?.textContent;

  it("groups rows by date and filters them by tool with counts", async () => {
    await renderSessionList(rows);
    expect(screen.getByText("Today")).toBeDefined();
    expect(screen.getByText("Earlier")).toBeDefined();
    expect(screen.getByText("3 sessions")).toBeDefined();

    const chips = screen.getByRole("group", { name: "Filter sessions" });
    expect(chips.textContent).toBe("All3Israel Code2Claude Code1");
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("Fix the cart test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^All\d/ }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("searches titles, opens the top match on Enter, and Esc clears then goes back", async () => {
    await renderSessionList(rows);
    fireEvent.keyDown(document.body, { key: "/" });
    const search = screen.getByRole("combobox", { name: "Search sessions" });
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "API" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    // A second Esc goes back to all projects.
    fireEvent.keyDown(search, { key: "Escape" });
    expect(await screen.findByText("Choose a project")).toBeDefined();
  });

  it("opens the top search match on Enter", async () => {
    await renderSessionList(rows);
    const search = screen.getByRole("combobox", { name: "Search sessions" });
    fireEvent.change(search, { target: { value: "docs" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, "/s/b.jsonl"));
  });

  it("moves the selection with the arrow keys, Home and End, and opens it", async () => {
    await renderSessionList(rows);
    expect(selectedTitle()).toBe("Fix the cart test");
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(selectedTitle()).toBe("Write API docs");
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(
      document.querySelector("[aria-selected=true]")?.id,
    );
    fireEvent.keyDown(document.body, { key: "End" });
    expect(selectedTitle()).toBe(FOREIGN_SESSION.preview);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(selectedTitle()).toBe(FOREIGN_SESSION.preview);
    fireEvent.keyDown(document.body, { key: "Home" });
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, "/s/b.jsonl"));
  });

  it("opens the selected session in a new window on Ctrl+Enter", async () => {
    await renderSessionList(rows);
    fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(vi.mocked(newWindow)).toHaveBeenCalledWith({
        mode: "code",
        chatAgent: "general",
        cwd: PROJECT.path,
        sessionPath: "/s/a.jsonl",
      }),
    );
    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("marks running sessions and offers a Running filter", async () => {
    vi.mocked(listBackgroundSessions).mockResolvedValueOnce([
      {
        id: "bg",
        sessionPath: "/s/b.jsonl",
        cwd: PROJECT.path,
        mode: "code",
        chatAgent: null,
        title: "",
        status: "running",
        detail: null,
        attached: false,
        startedAt: null,
        updatedAt: 0,
      },
    ]);
    await renderSessionList(rows);
    const running = await screen.findByRole("button", { name: /^Running/ });
    fireEvent.click(running);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("Write API docs");
    expect(options[0]?.querySelector(".sb-row-running")?.textContent).toBe("Running");
  });
});
