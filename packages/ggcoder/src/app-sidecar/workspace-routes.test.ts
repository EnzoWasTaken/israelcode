import type http from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverProjects = vi.fn(async (_options: Record<string, unknown>) => []);
vi.mock("../core/project-discovery.js", () => ({
  discoverProjects: (options: Record<string, unknown>) => discoverProjects(options),
}));
vi.mock("./app-settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAppSettings: vi.fn(async () => ({
    projectsRoot: "/home/u/gg-projects",
    projectRoots: ["/home/u/elsewhere"],
    hiddenProjects: ["/home/u/gg-projects/old"],
  })),
}));

const { handleDiscoveryRoutes } = await import("./workspace-routes.js");

function get(url: string, agentDir: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as unknown });
      },
    };
    handleDiscoveryRoutes(
      { agentDir, sessionsDir: path.join(agentDir, "sessions") },
      res as unknown as http.ServerResponse,
      url,
      "GET",
    );
  });
}

describe("GET /projects", () => {
  beforeEach(() => discoverProjects.mockClear());

  it("never lists Goal workspaces under Choose a project", async () => {
    const reply = await get("/projects", "/home/u/.gg");
    expect(reply.status).toBe(200);
    expect(discoverProjects).toHaveBeenCalledOnce();
    // Goal folders live under ~/.gg/goals; their sessions look like projects'.
    // Built with the platform's separators (backslashes on Windows).
    expect(discoverProjects.mock.calls[0]?.[0]).toMatchObject({
      projectsRoot: "/home/u/gg-projects",
      excludeRoots: [path.join("/home/u/.gg", "goals"), path.join("/home/u/.gg", "worktrees")],
    });
  });
});

it("reports a failed discovery without replacing a successful retry with empty rows", async () => {
  discoverProjects.mockRejectedValueOnce(new Error("scan failed"));
  expect((await get("/projects", "/home/u/.gg")).status).toBe(500);
  expect((await get("/projects", "/home/u/.gg")).status).toBe(200);
});
