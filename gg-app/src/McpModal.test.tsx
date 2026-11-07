// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { listMcpServers, listProjects, type McpServerRow } from "./agent";
import { McpModal } from "./McpModal";

vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  addMcpServer: vi.fn(),
  listMcpServers: vi.fn(),
  listProjects: vi.fn(),
  loginMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  searchMcpMarket: vi.fn(),
  inspectMcpMarket: vi.fn(),
  addMcpFromMarket: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const listMcpServersMock = vi.mocked(listMcpServers);
const listProjectsMock = vi.mocked(listProjects);

const SERVER: McpServerRow = {
  name: "github",
  scope: "global",
  ok: true,
  toolCount: 12,
  kind: "http",
  summary: "https://example.test/mcp",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpModal", () => {
  it("says the list couldn't be fetched instead of 'No MCP's configured', and retries", async () => {
    listProjectsMock.mockResolvedValue([]);
    // Mount lists twice (initial + scope effect); both fail.
    listMcpServersMock.mockRejectedValue(new Error("daemon down"));

    render(<McpModal onClose={vi.fn()} />);

    expect(await screen.findByText("Couldn't reach the agent to list servers.")).toBeTruthy();
    expect(screen.queryByText(/No MCP.s configured/)).toBeNull();

    listMcpServersMock.mockResolvedValue([SERVER]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("github")).toBeTruthy();
    expect(screen.queryByText("Couldn't reach the agent to list servers.")).toBeNull();
  });

  it("shows the marketplace when Browse marketplace is clicked", async () => {
    listProjectsMock.mockResolvedValue([]);
    listMcpServersMock.mockResolvedValue([SERVER]);
    render(<McpModal onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Search the MCP marketplace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browse marketplace" }));
    expect(await screen.findByLabelText("Search the MCP marketplace")).toBeTruthy();
  });
});
