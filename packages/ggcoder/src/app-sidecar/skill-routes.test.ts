import { Readable } from "node:stream";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SkillFinder from "../core/skill-finder.js";
import type * as SkillInstall from "../core/skill-install.js";

vi.mock("../core/skill-finder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SkillFinder>();
  return {
    ...actual,
    searchSkills: vi.fn(),
    fetchSkillDetails: vi.fn(),
    listRepoSkills: vi.fn(),
    fetchSkillAudits: vi.fn(async () => new Map()),
  };
});
vi.mock("../core/skill-install-scan.js", () => ({ scanSkillSnapshotFiles: vi.fn() }));
vi.mock("../core/skill-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SkillInstall>();
  return {
    ...actual,
    installSkillSnapshot: vi.fn(),
    listInstalledSkills: vi.fn(),
    removeInstalledSkill: vi.fn(),
  };
});
vi.mock("../core/logger.js", () => ({ log: vi.fn() }));

import { log } from "../core/logger.js";
import * as finder from "../core/skill-finder.js";
import { scanSkillSnapshotFiles } from "../core/skill-install-scan.js";
import * as install from "../core/skill-install.js";
import { clearSkillSnapshotCache, handleSkillRoutes } from "./skill-routes.js";
import type { SessionRouteContext } from "./route-context.js";

interface Reply {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: http.ServerResponse; reply: Promise<Reply> } {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  return { res: res as unknown as http.ServerResponse, reply };
}

const ctx = { host: "127.0.0.1:1", cwd: "C:\\proj" } as unknown as SessionRouteContext;

function call(method: string, url: string, body?: unknown): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req =
    body === undefined
      ? ({} as http.IncomingMessage)
      : (Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage);
  expect(handleSkillRoutes(ctx, req, res, url, method)).toBe(true);
  return reply;
}

const snapshot: finder.SkillSnapshot = {
  source: "acme/skills",
  slug: "deploy",
  origin: "skills.sh",
  hash: "h1",
  files: [{ path: "SKILL.md", contents: "---\nname: deploy\ndescription: Ship\n---\nGo\n" }],
};
const PASS = { verdict: "pass" as const, findings: [], summary: "No findings", rulesRun: 3 };
const BLOCK = {
  verdict: "block" as const,
  findings: [
    {
      rule: "EXE-01",
      title: "Shell",
      severity: "high" as const,
      file: "SKILL.md",
      line: 1,
      reason: "r",
    },
  ],
  summary: "1 blocking finding",
  rulesRun: 3,
};

describe("skill routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSkillSnapshotCache();
    vi.mocked(finder.fetchSkillDetails).mockResolvedValue(snapshot);
    vi.mocked(scanSkillSnapshotFiles).mockReturnValue(PASS);
  });

  it("ignores unrelated urls", () => {
    const { res } = fakeResponse();
    expect(handleSkillRoutes(ctx, {} as http.IncomingMessage, res, "/mcp", "GET")).toBe(false);
  });

  it("GET /skills/search passes the query through and maps finder errors", async () => {
    vi.mocked(finder.searchSkills).mockResolvedValueOnce({ results: [], origin: "skills.sh" });
    expect(await call("GET", "/skills/search?q=deploy%20now")).toEqual({
      status: 200,
      body: { results: [], origin: "skills.sh" },
    });
    expect(finder.searchSkills).toHaveBeenCalledWith("deploy now");
    vi.mocked(finder.searchSkills).mockRejectedValueOnce(new finder.SkillFinderError("rate", 403));
    expect(await call("GET", "/skills/search?q=x")).toEqual({
      status: 429,
      body: { error: "rate" },
    });
  });

  it("POST /skills/inspect returns summary, scan and audits for a skill", async () => {
    vi.mocked(finder.fetchSkillAudits).mockResolvedValueOnce(
      new Map([["deploy", [{ provider: "Socket", risk: "safe" as const }]]]),
    );
    const reply = await call("POST", "/skills/inspect", { source: "acme/skills", slug: "deploy" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      source: "acme/skills",
      slug: "deploy",
      hash: "h1",
      summary: { name: "deploy", description: "Ship", fileCount: 1 },
      scan: PASS,
      audits: [{ provider: "Socket", risk: "safe" }],
    });
    expect(scanSkillSnapshotFiles).toHaveBeenCalledWith(snapshot.files);
  });

  it("POST /skills/inspect with an empty slug lists the repo's skills to choose from", async () => {
    vi.mocked(finder.listRepoSkills).mockResolvedValueOnce({
      sha: "a".repeat(40),
      skills: [
        { slug: "one", path: "skills/one" },
        { slug: "two", path: "skills/two" },
      ],
    });
    const reply = await call("POST", "/skills/inspect", { source: "acme/skills", slug: "" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      slug: "",
      candidates: [{ slug: "one" }, { slug: "two" }],
      summary: { fileCount: 0 },
      scan: { verdict: "pass", rulesRun: 0 },
    });
    expect(finder.fetchSkillDetails).not.toHaveBeenCalled();
  });

  it("POST /skills/install reuses the inspected snapshot and records the entry", async () => {
    const entry = { name: "deploy", scope: "global", path: "x", hash: "h1" };
    vi.mocked(install.installSkillSnapshot).mockResolvedValueOnce(entry as never);
    await call("POST", "/skills/inspect", { source: "acme/skills", slug: "deploy" });
    const reply = await call("POST", "/skills/install", {
      source: "acme/skills",
      slug: "deploy",
      scope: "global",
    });
    expect(reply).toEqual({ status: 200, body: { installed: true, entry, scan: PASS } });
    expect(finder.fetchSkillDetails).toHaveBeenCalledTimes(1);
    expect(install.installSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot, scope: "global", overridden: false, replace: false }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("POST /skills/install answers 409 with the scan when blocked, installs with override", async () => {
    vi.mocked(scanSkillSnapshotFiles).mockReturnValue(BLOCK);
    const blocked = await call("POST", "/skills/install", {
      source: "acme/skills",
      slug: "deploy",
      scope: "project",
      projectCwd: "C:\\other",
    });
    expect(blocked).toEqual({
      status: 409,
      body: { installed: false, scan: BLOCK, error: "Blocked by the security scan" },
    });
    expect(install.installSkillSnapshot).not.toHaveBeenCalled();

    vi.mocked(install.installSkillSnapshot).mockResolvedValueOnce({ name: "deploy" } as never);
    const forced = await call("POST", "/skills/install", {
      source: "acme/skills",
      slug: "deploy",
      scope: "project",
      projectCwd: "C:\\other",
      override: true,
      replace: true,
    });
    expect(forced.status).toBe(200);
    expect(install.installSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: "C:\\other", overridden: true, replace: true }),
    );
    expect(log).toHaveBeenCalledWith(
      "WARN",
      "app-sidecar",
      "skill installed despite blocking findings",
      { source: "acme/skills", slug: "deploy", findings: 1 },
    );
  });

  it("POST /skills/install maps an existing different version to 409", async () => {
    vi.mocked(install.installSkillSnapshot).mockRejectedValueOnce(
      new install.SkillInstallError("already there", "exists"),
    );
    expect(
      await call("POST", "/skills/install", { source: "acme/skills", slug: "deploy" }),
    ).toEqual({
      status: 409,
      body: { installed: false, error: "already there" },
    });
  });

  it("GET /skills/installed and POST /skills/remove proxy to the install module", async () => {
    vi.mocked(install.listInstalledSkills).mockResolvedValueOnce([{ name: "a" }] as never);
    expect(await call("GET", "/skills/installed?project=D%3A%5Cp")).toEqual({
      status: 200,
      body: { skills: [{ name: "a" }] },
    });
    expect(install.listInstalledSkills).toHaveBeenCalledWith("D:\\p");
    vi.mocked(install.listInstalledSkills).mockResolvedValueOnce([]);
    await call("GET", "/skills/installed");
    expect(install.listInstalledSkills).toHaveBeenLastCalledWith("C:\\proj");

    vi.mocked(install.removeInstalledSkill).mockResolvedValueOnce(true);
    expect(await call("POST", "/skills/remove", { name: "a", scope: "global" })).toEqual({
      status: 200,
      body: { removed: true },
    });
    expect(install.removeInstalledSkill).toHaveBeenCalledWith("a", "global", "C:\\proj");
    expect(await call("POST", "/skills/remove", { name: "", scope: "global" })).toMatchObject({
      status: 400,
    });
  });
});
