import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverClaudePlugins,
  loadPluginAgents,
  loadPluginCommands,
  mapClaudeTools,
} from "./claude-plugins.js";
import { discoverSkillsWithBlocked } from "./skills.js";

let tmp: string;
let claudeHome: string;
let project: string;

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const skill = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-claude-plugins-"));
  claudeHome = path.join(tmp, "claude");
  project = path.join(tmp, "project");
  await fs.mkdir(project, { recursive: true });

  // A marketplace install, enabled in user settings.
  const kit = path.join(claudeHome, "plugins", "cache", "mkt", "kit", "1.0.0");
  await write(path.join(kit, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  await write(path.join(kit, "skills", "lint", "SKILL.md"), skill("lint"));
  await write(
    path.join(kit, "commands", "ship.md"),
    "---\ndescription: Ship it\n---\nShip $ARGUMENTS now.\n",
  );
  await write(
    path.join(kit, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews\ntools: Read, Glob, Bash\nmodel: sonnet\n---\nReview.\n",
  );
  await write(
    path.join(kit, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        api: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
        secret: { url: "https://x.test", headers: { Authorization: "${user_config.token}" } },
      },
    }),
  );
  // Installed but switched off.
  const off = path.join(claudeHome, "plugins", "cache", "mkt", "off", "1.0.0");
  await write(path.join(off, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "off" }));
  await write(
    path.join(claudeHome, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "kit@mkt": [{ scope: "user", installPath: kit, version: "1.0.0" }],
        "off@mkt": [{ scope: "user", installPath: off, version: "1.0.0" }],
      },
    }),
  );
  await write(
    path.join(claudeHome, "settings.json"),
    JSON.stringify({ enabledPlugins: { "kit@mkt": true, "off@mkt": false } }),
  );

  // A project skills-dir plugin with a component path that escapes its folder.
  const repoPlugin = path.join(project, ".claude", "skills", "repo-kit");
  await write(
    path.join(repoPlugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "repo-kit", skills: ["../../../outside"] }),
  );
  await write(path.join(project, "outside", "evil", "SKILL.md"), skill("evil"));
  await write(path.join(repoPlugin, "skills", "fmt", "SKILL.md"), skill("fmt"));

  // Plain Claude skills, one clashing with an Israel Code skill.
  await write(path.join(claudeHome, "skills", "notes", "SKILL.md"), skill("notes"));
  await write(
    path.join(project, ".claude", "skills", "deploy", "SKILL.md"),
    skill("deploy", "claude"),
  );
  await write(path.join(project, ".gg", "skills", "deploy", "SKILL.md"), skill("deploy", "ours"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("discoverClaudePlugins", () => {
  it("loads enabled installs and skills-dir plugins, nothing else", async () => {
    const plugins = await discoverClaudePlugins({ cwd: project, claudeHome });
    expect(plugins.map((p) => [p.id, p.scope])).toEqual([
      ["kit@mkt", "user"],
      ["repo-kit@skills-dir", "project"],
    ]);
    const repo = plugins[1]!;
    // The escaping `skills` path is refused; the default skills/ folder stays.
    expect(repo.skillDirs).toEqual([path.join(repo.root, "skills")]);
  });

  it("reads MCP servers with the plugin root filled in and skips user_config ones", async () => {
    const [kit] = await discoverClaudePlugins({ cwd: project, claudeHome });
    expect(kit!.mcpServers).toHaveLength(1);
    expect(kit!.mcpServers[0]).toMatchObject({
      name: "kit_api",
      command: "node",
      args: [`${kit!.root}/server.js`],
    });
    expect(kit!.mcpServers[0]!.env?.CLAUDE_PLUGIN_ROOT).toBe(kit!.root);
  });

  it("still finds a repository's plugin when Claude Code isn't installed", async () => {
    const plugins = await discoverClaudePlugins({
      cwd: project,
      claudeHome: path.join(tmp, "none"),
    });
    expect(plugins.map((p) => p.id)).toEqual(["repo-kit@skills-dir"]);
    expect(await discoverClaudePlugins({ claudeHome: path.join(tmp, "none") })).toEqual([]);
  });
});

describe("plugin components", () => {
  it("namespaces commands and agents and translates Claude tool names", async () => {
    const plugins = await discoverClaudePlugins({ cwd: project, claudeHome });
    const commands = await loadPluginCommands(plugins);
    expect(commands.map((c) => c.name)).toEqual(["kit:ship"]);
    expect(commands[0]).toMatchObject({ description: "Ship it", prompt: "Ship $ARGUMENTS now." });

    const [agent] = await loadPluginAgents(plugins);
    expect(agent).toMatchObject({
      name: "kit:reviewer",
      model: "inherit",
      tools: ["read", "find", "bash"],
    });
  });

  it("maps Task to the sub-agent tools and keeps MCP names", () => {
    expect(mapClaudeTools(["Task", "mcp__x__y", "TodoWrite"])).toEqual([
      "spawn_agent",
      "wait_agent",
      "mcp__x__y",
      "todo_write",
    ]);
    expect(mapClaudeTools([])).toEqual([]);
  });
});

describe("skills from Claude folders and plugins", () => {
  it("adds them, namespaces plugin skills, and lets Israel Code's own win a clash", async () => {
    const plugins = await discoverClaudePlugins({ cwd: project, claudeHome });
    const { skills } = await discoverSkillsWithBlocked({
      globalSkillsDir: path.join(tmp, "israel", "skills"),
      projectDir: project,
      claude: { home: claudeHome, plugins },
    });
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(["kit:lint", "repo-kit:fmt", "notes", "deploy"]),
    );
    expect(byName.has("evil")).toBe(false);
    expect(byName.get("deploy")?.content.trim()).toBe("ours");
  });

  it("leaves Claude folders alone unless asked", async () => {
    const { skills } = await discoverSkillsWithBlocked({
      globalSkillsDir: path.join(tmp, "israel", "skills"),
      projectDir: project,
    });
    expect(skills.some((s) => s.name === "notes" || s.name === "kit:lint")).toBe(false);
  });
});
