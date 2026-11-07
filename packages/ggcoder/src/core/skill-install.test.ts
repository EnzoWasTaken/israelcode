import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_DIR_NAME } from "@kenkaiiii/gg-core";
import type { InstallScanResult } from "./skill-install-scan.js";
import type { SkillSnapshot } from "./skill-finder.js";
import {
  installSkillSnapshot,
  listInstalledSkills,
  readSkillsLock,
  removeInstalledSkill,
  skillsRootFor,
  SkillInstallError,
} from "./skill-install.js";

const PASS: InstallScanResult = {
  verdict: "pass",
  findings: [],
  summary: "No findings",
  rulesRun: 1,
};
const BLOCK: InstallScanResult = {
  verdict: "block",
  findings: [
    {
      rule: "EXE-01",
      title: "Runs a shell",
      severity: "high",
      file: "SKILL.md",
      line: 3,
      reason: "curl | sh",
    },
  ],
  summary: "1 blocking finding",
  rulesRun: 1,
};

function snapshot(over: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    source: "acme/skills",
    slug: "deploy",
    origin: "skills.sh",
    hash: "h1",
    files: [
      { path: "SKILL.md", contents: "---\nname: Deploy\ndescription: Ship it\n---\nBody\n" },
      { path: "scripts/run.sh", contents: "echo hi\n" },
    ],
    ...over,
  };
}

describe("skill-install", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-skill-home-"));
    project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-skill-proj-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  });

  it("resolves the skills root per scope", () => {
    expect(skillsRootFor("global", null, home)).toBe(path.join(home, APP_DIR_NAME, "skills"));
    expect(skillsRootFor("project", project, home)).toBe(path.join(project, ".gg", "skills"));
    expect(() => skillsRootFor("project", null, home)).toThrow(SkillInstallError);
  });

  it("writes the files under the frontmatter name and records a lock entry", async () => {
    const entry = await installSkillSnapshot({
      snapshot: snapshot(),
      scope: "global",
      scan: PASS,
      homeDir: home,
      now: () => new Date("2026-11-06T10:00:00Z"),
    });
    const root = skillsRootFor("global", null, home);
    expect(entry).toMatchObject({
      name: "deploy",
      scope: "global",
      path: path.join(root, "deploy"),
      source: "acme/skills",
      slug: "deploy",
      hash: "h1",
      verdict: "pass",
      overridden: false,
      installedAt: "2026-11-06T10:00:00.000Z",
    });
    expect(await fs.readFile(path.join(root, "deploy", "scripts", "run.sh"), "utf-8")).toBe(
      "echo hi\n",
    );
    const lock = await readSkillsLock(root);
    expect(lock.version).toBe(1);
    expect(lock.skills.deploy?.hash).toBe("h1");
    // No temp folder left behind.
    const names = await fs.readdir(root);
    expect(names.sort()).toEqual(["deploy", "skills-lock.json"]);
  });

  it("refuses a different version of an installed skill unless replace is set", async () => {
    await installSkillSnapshot({
      snapshot: snapshot(),
      scope: "global",
      scan: PASS,
      homeDir: home,
    });
    const changed = snapshot({
      hash: "h2",
      files: [{ path: "SKILL.md", contents: "---\nname: deploy\n---\nv2\n" }],
    });
    await expect(
      installSkillSnapshot({ snapshot: changed, scope: "global", scan: PASS, homeDir: home }),
    ).rejects.toMatchObject({ code: "exists" });
    // Same hash: a re-install is fine.
    await installSkillSnapshot({
      snapshot: snapshot(),
      scope: "global",
      scan: PASS,
      homeDir: home,
    });
    const replaced = await installSkillSnapshot({
      snapshot: changed,
      scope: "global",
      scan: BLOCK,
      overridden: true,
      replace: true,
      homeDir: home,
    });
    expect(replaced).toMatchObject({ hash: "h2", verdict: "block", overridden: true });
    const root = skillsRootFor("global", null, home);
    await expect(fs.stat(path.join(root, "deploy", "scripts"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf-8")).toContain("v2");
  });

  it("rejects paths that escape the skill folder and bad names", async () => {
    await expect(
      installSkillSnapshot({
        snapshot: snapshot({ files: [{ path: "../evil.md", contents: "x" }] }),
        scope: "global",
        scan: PASS,
        homeDir: home,
      }),
    ).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(
      installSkillSnapshot({
        snapshot: snapshot({ files: [{ path: "C:/evil.md", contents: "x" }] }),
        scope: "global",
        scan: PASS,
        homeDir: home,
      }),
    ).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(
      installSkillSnapshot({
        snapshot: snapshot(),
        scope: "global",
        name: "Bad Name!",
        scan: PASS,
        homeDir: home,
      }),
    ).rejects.toMatchObject({ code: "invalid-name" });
    await expect(fs.stat(path.join(home, APP_DIR_NAME, "skills", "deploy"))).rejects.toThrow();
  });

  it("lists both scopes, including folders without a lock entry", async () => {
    await installSkillSnapshot({
      snapshot: snapshot(),
      scope: "global",
      scan: PASS,
      homeDir: home,
    });
    await installSkillSnapshot({
      snapshot: snapshot({
        slug: "review",
        hash: "h3",
        files: [{ path: "SKILL.md", contents: "r" }],
      }),
      scope: "project",
      projectCwd: project,
      scan: PASS,
      homeDir: home,
    });
    const manual = path.join(home, APP_DIR_NAME, "skills", "handmade");
    await fs.mkdir(manual, { recursive: true });
    await fs.writeFile(path.join(manual, "SKILL.md"), "hi");
    await fs.mkdir(path.join(home, APP_DIR_NAME, "skills", "notaskill"), { recursive: true });

    const rows = await listInstalledSkills(project, home);
    expect(rows.map((r) => [r.name, r.scope, r.hash])).toEqual([
      ["deploy", "global", "h1"],
      ["handmade", "global", undefined],
      ["review", "project", "h3"],
    ]);
    expect(await listInstalledSkills(undefined, home)).toHaveLength(2);
  });

  it("removes the folder and the lock entry", async () => {
    await installSkillSnapshot({
      snapshot: snapshot(),
      scope: "global",
      scan: PASS,
      homeDir: home,
    });
    expect(await removeInstalledSkill("deploy", "global", null, home)).toBe(true);
    const root = skillsRootFor("global", null, home);
    await expect(fs.stat(path.join(root, "deploy"))).rejects.toThrow();
    expect((await readSkillsLock(root)).skills).toEqual({});
    expect(await removeInstalledSkill("deploy", "global", null, home)).toBe(false);
  });
});
