import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings, listProjects, listSessions, type RecentSession } from "./agent";
import { loadHomeRecents, mergeRecents, pickRecentProjects, type HomeRecent } from "./home-recents";

vi.mock("./agent", () => ({
  getSettings: vi.fn(),
  waitForReady: vi.fn(async () => undefined),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const s = (path: string, ms?: number): RecentSession => ({
  id: path,
  path,
  preview: path,
  lastActiveDisplay: "",
  messageCount: 1,
  ...(ms !== undefined ? { lastActiveMs: ms } : {}),
});
const row = (path: string, ms?: number): HomeRecent => ({
  kind: "code",
  cwd: "/p",
  where: "p",
  session: s(path, ms),
});
const project = (path: string, ms?: number) => ({
  name: path.slice(1),
  path,
  lastActiveDisplay: "",
  sources: [],
  ...(ms !== undefined ? { lastActiveMs: ms } : {}),
});

describe("mergeRecents", () => {
  it("sorts newest first, keeps untimed rows after in list order, dedupes, caps", () => {
    const merged = mergeRecents(
      [
        [row("a", 10), row("b"), row("c", 30)],
        [row("d"), row("a", 10), row("e", 20)],
      ],
      4,
    );
    expect(merged.map((r) => r.session.path)).toEqual(["c", "e", "a", "b"]);
  });
});

describe("pickRecentProjects", () => {
  it("prefers lastActiveMs and falls back to the server's order", () => {
    const picked = pickRecentProjects(
      [project("/a"), project("/b", 5), project("/c"), project("/d", 9)],
      3,
    );
    expect(picked.map((p) => p.path)).toEqual(["/d", "/b", "/a"]);
  });
});

describe("loadHomeRecents", () => {
  it("merges the top 3 projects with every chat", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/root", configured: true } as never);
    vi.mocked(listProjects).mockResolvedValue([
      project("/one", 4),
      project("/two", 3),
      project("/three", 2),
      project("/four", 1),
    ]);
    vi.mocked(listSessions).mockImplementation(async (cwd) =>
      cwd === "/root" ? [{ ...s("/root/c", 50), chatAgent: "therapist" }] : [s(`${cwd}/x`, 10)],
    );
    const rows = await loadHomeRecents();
    expect(listSessions).not.toHaveBeenCalledWith("/four");
    expect(listSessions).toHaveBeenCalledWith("/root", "all");
    expect(rows[0]).toMatchObject({ kind: "chat", where: "Chat \u00b7 Therapist", cwd: "/root" });
    expect(rows).toHaveLength(4);
  });

  it("keeps the lists that loaded when one fails, and fails only if all do", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/root", configured: true } as never);
    vi.mocked(listProjects).mockRejectedValue(new Error("no discovery"));
    vi.mocked(listSessions).mockResolvedValue([s("/root/c", 1)]);
    expect((await loadHomeRecents()).map((r) => r.session.path)).toEqual(["/root/c"]);
    vi.mocked(listSessions).mockRejectedValue(new Error("down"));
    await expect(loadHomeRecents()).rejects.toThrow("no discovery");
  });
});
