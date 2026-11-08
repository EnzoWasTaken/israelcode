// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getSettings,
  listSessions,
  newWindow,
  selectWorkspace,
  waitForReady,
  type RecentSession,
} from "./agent";
import { ChatPicker } from "./ChatPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  listBackgroundSessions: vi.fn(() => Promise.resolve([])),
  newWindow: vi.fn(() => Promise.resolve()),
  onBackgroundSessions: vi.fn(() => () => undefined),
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  selectWorkspace: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({
  WindowLayoutButton: () => <button>Windows</button>,
}));

const getSettingsMock = vi.mocked(getSettings);
const listSessionsMock = vi.mocked(listSessions);
const selectWorkspaceMock = vi.mocked(selectWorkspace);
const waitForReadyMock = vi.mocked(waitForReady);

const session: RecentSession = {
  id: "chat-1",
  path: "/sessions/chat-1.jsonl",
  preview: "Plan my week",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
  chatAgent: "therapist",
};

// Pickers keep their last list per window (useCachedList); each test starts
// from a first visit.
beforeEach(() => sessionStorage.clear());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatPicker", () => {
  it("loads sessions from projectsRoot and resumes them in chat mode", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    selectWorkspaceMock.mockResolvedValue();
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} />);

    expect(await screen.findByText("Plan my week")).toBeDefined();
    expect(waitForReadyMock).toHaveBeenCalledOnce();
    expect(listSessionsMock).toHaveBeenCalledWith("/workspaces", "all");

    fireEvent.click(screen.getByText("Plan my week"));
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "chat",
        "/workspaces",
        "/sessions/chat-1.jsonl",
        "therapist",
      );
      expect(onChosen).toHaveBeenCalledWith("/workspaces");
    });
  });

  it("starts a new chat without a resume path", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();

    render(<ChatPicker onChosen={vi.fn()} />);

    const newChatButtons = await screen.findAllByRole("button", { name: "+ New chat" });
    fireEvent.click(newChatButtons[0]);
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith("chat", "/workspaces", undefined, "general");
    });
  });

  it("starts a new chat with the initially active agent", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();

    render(<ChatPicker onChosen={vi.fn()} initialAgent="research" />);
    const newChatButtons = await screen.findAllByRole("button", { name: "+ New chat" });
    fireEvent.click(newChatButtons[0]);

    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledWith("/workspaces", "all");
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "chat",
        "/workspaces",
        undefined,
        "research",
      );
    });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("opens Motion in its own folder and lists only Motion sessions", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces/", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();
    const onChosen = vi.fn();

    render(<ChatPicker mode="motion" onChosen={onChosen} />);

    expect(await screen.findByText(/No videos yet/)).toBeDefined();
    expect(listSessionsMock).toHaveBeenCalledWith("/workspaces/Israel Motion", "motion");
    fireEvent.click(screen.getAllByRole("button", { name: "+ New video" })[0]);
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "motion",
        "/workspaces/Israel Motion",
        undefined,
        "general",
      );
      expect(onChosen).toHaveBeenCalledWith("/workspaces/Israel Motion");
    });
  });

  it("says why a chat didn't open and lets the user try again", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    selectWorkspaceMock.mockRejectedValueOnce(new Error("agent not ready"));
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} />);
    fireEvent.click(await screen.findByText("Plan my week"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("agent not ready");
    expect(onChosen).not.toHaveBeenCalled();
    // `busy` is released, so the row works again.
    const row = screen.getByText("Plan my week").closest("[role=option]");
    expect(row?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("retries a failed session load", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockRejectedValueOnce(new Error("daemon down")).mockResolvedValue([session]);

    render(<ChatPicker onChosen={vi.fn()} />);

    expect(await screen.findByText("daemon down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Plan my week")).toBeTruthy();
  });

  it("shows a clear prerequisite error when projectsRoot is unavailable", async () => {
    getSettingsMock.mockResolvedValue(null);

    render(<ChatPicker onChosen={vi.fn()} />);

    expect(
      await screen.findByText("Choose a projects folder in Settings before starting a chat."),
    ).toBeDefined();
    expect(waitForReadyMock).not.toHaveBeenCalled();
    expect(selectWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe("ChatPicker session browser", () => {
  const chats: RecentSession[] = [
    { ...session, lastActiveMs: Date.now() - 60_000 },
    {
      ...session,
      id: "chat-2",
      path: "/sessions/chat-2.jsonl",
      preview: "Read up on tides",
      chatAgent: "research",
      lastActiveMs: Date.now() - 120_000,
    },
    {
      ...session,
      id: "chat-3",
      path: "/sessions/chat-3.jsonl",
      preview: "Weekly check-in",
      chatAgent: "therapist",
      lastActiveMs: Date.now() - 180_000,
    },
  ];

  async function renderChats(onClose = vi.fn()): Promise<void> {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue(chats);
    selectWorkspaceMock.mockResolvedValue();
    render(<ChatPicker onChosen={vi.fn()} onClose={onClose} />);
    await screen.findByText("Plan my week");
    // The projects folder is read on its own; opening waits for it.
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
  }

  it("filters chats by agent display name", async () => {
    await renderChats();
    const chips = screen.getByRole("group", { name: "Filter chats" });
    expect(chips.textContent).toBe("All3Therapist2Research1");
    fireEvent.click(screen.getByRole("button", { name: /^Research/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Read up on tides"),
    ]);
  });

  it("opens the arrow-selected chat with its agent on Enter", async () => {
    await renderChats();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() =>
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "chat",
        "/workspaces",
        "/sessions/chat-2.jsonl",
        "research",
      ),
    );
  });

  it("searches, and Esc clears the search before going back", async () => {
    const onClose = vi.fn();
    await renderChats(onClose);
    const search = screen.getByRole("combobox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "TIDES" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens a chat in a new window from its row action", async () => {
    await renderChats();
    fireEvent.click(screen.getByRole("button", { name: "Open Weekly check-in in a new window" }));
    await waitFor(() =>
      expect(vi.mocked(newWindow)).toHaveBeenCalledWith({
        mode: "chat",
        chatAgent: "therapist",
        cwd: "/workspaces",
        sessionPath: "/sessions/chat-3.jsonl",
      }),
    );
  });
});
