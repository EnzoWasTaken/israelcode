import { describe, expect, it, vi } from "vitest";
import {
  fetchSkillDetails,
  hashSkillFiles,
  searchSkills,
  SkillFinderError,
  summarizeSkill,
} from "./skill-finder.js";

type Route = (url: string) => { status?: number; body?: unknown } | undefined;

function fakeFetch(route: Route): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = route(url);
    if (!hit) return new Response("not found", { status: 404 });
    const status = hit.status ?? 200;
    return new Response(status === 200 ? JSON.stringify(hit.body ?? {}) : "nope", {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("searchSkills", () => {
  it("maps the skills.sh search shape and drops malformed rows", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url.startsWith("https://skills.sh/api/search?q=deploy")) {
        return {
          body: {
            skills: [
              {
                id: "acme/skills/deploy",
                source: "acme/skills",
                skillId: "deploy",
                name: "Deploy",
                installs: 42,
              },
              { source: "../bad", skillId: "x" },
              { source: "acme/skills", skillId: "../up" },
            ],
          },
        };
      }
      return undefined;
    });
    const res = await searchSkills("deploy", { fetch: fetchFn });
    expect(res.origin).toBe("skills.sh");
    expect(res.notice).toBeUndefined();
    expect(res.results).toEqual([
      {
        id: "acme/skills/deploy",
        source: "acme/skills",
        slug: "deploy",
        name: "Deploy",
        installs: 42,
        origin: "skills.sh",
      },
    ]);
  });

  it("falls back to GitHub repository search with a notice", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url.startsWith("https://skills.sh/")) return { status: 500 };
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return {
          body: {
            items: [
              {
                full_name: "acme/agent-skills",
                name: "agent-skills",
                description: "Lots",
                stargazers_count: 7,
              },
            ],
          },
        };
      }
      return undefined;
    });
    const res = await searchSkills("deploy", { fetch: fetchFn });
    expect(res.origin).toBe("github");
    expect(res.notice).toContain("skills.sh was unavailable");
    expect(res.results).toEqual([
      {
        id: "acme/agent-skills",
        source: "acme/agent-skills",
        slug: "",
        name: "agent-skills",
        stars: 7,
        description: "Lots",
        origin: "github",
      },
    ]);
  });

  it("explains a GitHub 403 as rate limiting when both sources fail", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url.startsWith("https://skills.sh/")) return { status: 502 };
      return { status: 403 };
    });
    await expect(searchSkills("deploy", { fetch: fetchFn })).rejects.toThrow(
      /api\.github\.com is rate limiting this machine/,
    );
  });

  it("returns nothing for a blank query without fetching", async () => {
    const fetchFn = fakeFetch(() => undefined);
    expect(await searchSkills("   ", { fetch: fetchFn })).toEqual({
      results: [],
      origin: "skills.sh",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchSkillDetails", () => {
  it("accepts the skills.sh download shape and keeps its hash", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url === "https://skills.sh/api/download/acme/skills/deploy") {
        return {
          body: {
            hash: "abc123",
            files: [
              { path: "SKILL.md", contents: "---\nname: deploy\ndescription: Ship\n---\nGo\n" },
              { path: "scripts\\run.sh", contents: "echo" },
              { path: "SKILL.md", contents: "dup" },
            ],
          },
        };
      }
      return undefined;
    });
    const snap = await fetchSkillDetails("acme/skills", "deploy", { fetch: fetchFn });
    expect(snap).toMatchObject({
      source: "acme/skills",
      slug: "deploy",
      hash: "abc123",
      origin: "skills.sh",
    });
    expect(snap.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const summary = summarizeSkill(snap.files);
    expect(summary).toMatchObject({
      name: "deploy",
      description: "Ship",
      hasScripts: true,
      fileCount: 2,
    });
  });

  it("refuses a download whose file paths escape the skill folder", async () => {
    const fetchFn = fakeFetch(() => ({
      body: {
        files: [
          { path: "SKILL.md", contents: "x" },
          { path: "../../etc/passwd", contents: "y" },
        ],
      },
    }));
    await expect(fetchSkillDetails("acme/skills", "deploy", { fetch: fetchFn })).rejects.toThrow(
      SkillFinderError,
    );
    await expect(fetchSkillDetails("acme/skills", "deploy", { fetch: fetchFn })).rejects.toThrow(
      /Refused/,
    );
  });

  it("hashes identical snapshots alike regardless of order", () => {
    const a = [
      { path: "SKILL.md", contents: "x" },
      { path: "b.md", contents: "y" },
    ];
    expect(hashSkillFiles(a)).toBe(hashSkillFiles([...a].reverse()));
    expect(hashSkillFiles(a)).not.toBe(hashSkillFiles([{ path: "SKILL.md", contents: "z" }]));
  });
});
