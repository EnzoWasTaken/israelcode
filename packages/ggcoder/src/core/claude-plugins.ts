import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import type { MCPServerConfig } from "./mcp/types.js";
import { parseAgentFile, validateAgentTools, type AgentDefinition } from "./agents.js";
import type { CustomCommand } from "./custom-commands.js";
import { parseSkillFile } from "./skills.js";

/**
 * Read-only support for Claude Code plugins the user already installed:
 * their skills, slash commands, agents and MCP servers. Hooks, LSP servers,
 * monitors and output styles are not loaded, and nothing is ever installed.
 *
 * Sources (https://code.claude.com/docs/en/plugins/loading):
 * - marketplace installs listed in ~/.claude/plugins/installed_plugins.json and
 *   switched on under `enabledPlugins` in ~/.claude/settings.json (user) or the
 *   project's .claude/settings.json / settings.local.json;
 * - "skills-dir" plugins: a folder with .claude-plugin/plugin.json under
 *   ~/.claude/skills/ (user) or <project>/.claude/skills/ (project).
 */

export type PluginScope = "user" | "project";

export interface ClaudePlugin {
  /** Manifest name (components are namespaced under it, `name:component`). */
  name: string;
  /** `name@marketplace`, `name@skills-dir`. */
  id: string;
  root: string;
  scope: PluginScope;
  skillDirs: string[];
  commandFiles: Array<{ name: string; file?: string; content?: string; description?: string }>;
  agentFiles: string[];
  mcpServers: MCPServerConfig[];
}

interface Manifest {
  name?: unknown;
  defaultEnabled?: unknown;
  skills?: unknown;
  commands?: unknown;
  agents?: unknown;
  mcpServers?: unknown;
}

export interface ClaudePluginOptions {
  cwd?: string;
  /** Defaults to ~/.claude (tests point it elsewhere). */
  claudeHome?: string;
}

/** Claude Code's plugins root (CLAUDE_CODE_PLUGIN_CACHE_DIR overrides it there too). */
function pluginsRoot(claudeHome: string): string {
  return process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(claudeHome, "plugins");
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A component path inside the plugin, or null when it escapes the plugin root
 * (Claude Code rejects those too). Symlinks are resolved before the check.
 */
export async function containedPath(root: string, rel: string): Promise<string | null> {
  if (typeof rel !== "string" || rel.length === 0) return null;
  const joined = path.resolve(root, rel);
  let real: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
    real = await fs.realpath(joined);
  } catch {
    return null;
  }
  const inside = path.relative(realRoot, real);
  if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) return real;
  log("WARN", "plugins", "Plugin path escapes its folder; skipped", { root, path: rel });
  return null;
}

/** Merge `enabledPlugins` maps, later sources winning key by key. */
async function enabledPlugins(files: readonly string[]): Promise<Map<string, boolean>> {
  const merged = new Map<string, boolean>();
  for (const file of files) {
    const map = asObject(asObject(await readJson(file))?.enabledPlugins);
    for (const [id, on] of Object.entries(map ?? {})) {
      if (typeof on === "boolean") merged.set(id, on);
    }
  }
  return merged;
}

/** `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` in MCP server strings. */
function expandVars(value: string, root: string, dataDir: string): string {
  return value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir);
}

function toMcpConfig(
  pluginName: string,
  serverName: string,
  raw: unknown,
  root: string,
  dataDir: string,
): MCPServerConfig | null {
  const entry = asObject(raw);
  if (!entry) return null;
  const sub = (v: unknown): string | undefined =>
    typeof v === "string" ? expandVars(v, root, dataDir) : undefined;
  // `${user_config.*}` needs Claude Code's plugin setup prompt; skip rather than guess.
  if (JSON.stringify(entry).includes("${user_config.")) {
    log("INFO", "plugins", "Skipped a plugin MCP server that needs user config", {
      plugin: pluginName,
      server: serverName,
    });
    return null;
  }
  // Namespaced so a plugin can't shadow a server the user configured.
  const config: MCPServerConfig = { name: `${pluginName}_${serverName}`.replace(/[^\w-]/g, "_") };
  const url = sub(entry.url);
  const command = sub(entry.command);
  if (url) {
    config.url = url;
    const headers = asObject(entry.headers);
    if (headers) {
      config.headers = Object.fromEntries(
        Object.entries(headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, sub(v)!]] : [])),
      );
    }
    if (entry.type === "sse") config.transport = "sse";
    else if (entry.type === "http" || entry.type === "streamable-http") config.transport = "http";
  } else if (command) {
    config.command = command;
    const args = toList(entry.args).flatMap((a) => (typeof a === "string" ? [sub(a)!] : []));
    if (args.length) config.args = args;
    const env = asObject(entry.env);
    config.env = {
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...Object.fromEntries(
        Object.entries(env ?? {}).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, sub(v)!]] : [],
        ),
      ),
    };
  } else {
    return null;
  }
  if (typeof entry.timeout === "number") config.timeout = entry.timeout;
  return config;
}

async function loadMcpServers(
  manifest: Manifest,
  pluginName: string,
  root: string,
  dataDir: string,
): Promise<MCPServerConfig[]> {
  // .mcp.json first, then each manifest entry in order; a later name replaces an earlier one.
  const maps: Record<string, unknown>[] = [];
  const fromFile = async (rel: string): Promise<void> => {
    if (!rel.endsWith(".json")) return; // .mcpb/.dxt bundles and URLs are not supported
    const file = await containedPath(root, rel);
    const parsed = file ? asObject(await readJson(file)) : undefined;
    const servers = asObject(parsed?.mcpServers) ?? parsed;
    if (servers) maps.push(servers);
  };
  if (await isFile(path.join(root, ".mcp.json"))) await fromFile(".mcp.json");
  for (const item of toList(manifest.mcpServers)) {
    if (typeof item === "string") await fromFile(item);
    else if (asObject(item)) maps.push(asObject(item)!);
  }
  const byName = new Map<string, MCPServerConfig>();
  for (const map of maps) {
    for (const [serverName, raw] of Object.entries(map)) {
      const config = toMcpConfig(pluginName, serverName, raw, root, dataDir);
      if (config) byName.set(serverName, config);
    }
  }
  return [...byName.values()];
}

async function loadPlugin(
  root: string,
  fallbackName: string,
  id: (name: string) => string,
  scope: PluginScope,
  dataRoot: string,
): Promise<ClaudePlugin | null> {
  const manifestFile = path.join(root, ".claude-plugin", "plugin.json");
  const manifest = ((await readJson(manifestFile)) ?? {}) as Manifest;
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : fallbackName;
  if (!/^[^\s@:/\\]+$/.test(name)) return null;

  const skillDirs: string[] = [];
  if (await isDir(path.join(root, "skills"))) skillDirs.push(path.join(root, "skills"));
  for (const rel of toList(manifest.skills)) {
    const dir = typeof rel === "string" ? await containedPath(root, rel) : null;
    if (dir && (await isDir(dir)) && !skillDirs.includes(dir)) skillDirs.push(dir);
  }

  const commandFiles: ClaudePlugin["commandFiles"] = [];
  const addCommandPath = async (rel: string): Promise<void> => {
    const p = await containedPath(root, rel);
    if (!p) return;
    if (await isDir(p)) {
      for (const f of (await fs.readdir(p)).sort()) {
        if (f.endsWith(".md")) commandFiles.push({ name: f.slice(0, -3), file: path.join(p, f) });
      }
    } else if (p.endsWith(".md")) {
      commandFiles.push({ name: path.basename(p, ".md"), file: p });
    }
  };
  const commandMap = asObject(manifest.commands);
  if (commandMap) {
    for (const [cmdName, raw] of Object.entries(commandMap)) {
      const entry = asObject(raw);
      if (!entry) continue;
      const description = typeof entry.description === "string" ? entry.description : undefined;
      if (typeof entry.content === "string") {
        commandFiles.push({ name: cmdName, content: entry.content, description });
      } else if (typeof entry.source === "string") {
        const file = await containedPath(root, entry.source);
        if (file) commandFiles.push({ name: cmdName, file, description });
      }
    }
  } else if (manifest.commands !== undefined) {
    for (const rel of toList(manifest.commands))
      if (typeof rel === "string") await addCommandPath(rel);
  } else if (await isDir(path.join(root, "commands"))) {
    await addCommandPath("commands");
  }

  const agentFiles: string[] = [];
  if (manifest.agents !== undefined) {
    for (const rel of toList(manifest.agents)) {
      const file = typeof rel === "string" ? await containedPath(root, rel) : null;
      if (file?.endsWith(".md") && (await isFile(file))) agentFiles.push(file);
    }
  } else if (await isDir(path.join(root, "agents"))) {
    for (const f of (await fs.readdir(path.join(root, "agents"))).sort()) {
      if (f.endsWith(".md")) agentFiles.push(path.join(root, "agents", f));
    }
  }

  const pluginId = id(name);
  const dataDir = path.join(dataRoot, pluginId.replace(/[^\w.-]/g, "-"));
  const mcpServers = await loadMcpServers(manifest, name, root, dataDir);
  return { name, id: pluginId, root, scope, skillDirs, commandFiles, agentFiles, mcpServers };
}

/** Folders under a skills dir that carry a plugin manifest. */
async function skillsDirPlugins(skillsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries.sort()) {
    const root = path.join(skillsDir, entry);
    if (await isFile(path.join(root, ".claude-plugin", "plugin.json"))) roots.push(root);
  }
  return roots;
}

/**
 * Every enabled Claude Code plugin for this user (and project, when `cwd` is
 * given). Never throws: a broken plugin is logged and left out.
 */
export async function discoverClaudePlugins(
  options: ClaudePluginOptions = {},
): Promise<ClaudePlugin[]> {
  const claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude");
  const root = pluginsRoot(claudeHome);
  const dataRoot = path.join(root, "data");
  const settingsFiles = [
    path.join(claudeHome, "settings.json"),
    ...(options.cwd
      ? [
          path.join(options.cwd, ".claude", "settings.json"),
          path.join(options.cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];
  const enabled = await enabledPlugins(settingsFiles);
  const plugins: ClaudePlugin[] = [];
  const seen = new Set<string>();
  const add = (plugin: ClaudePlugin | null): void => {
    // First one wins on a name clash, as components are namespaced by name.
    if (!plugin || seen.has(plugin.name)) return;
    seen.add(plugin.name);
    plugins.push(plugin);
  };

  try {
    // Marketplace installs.
    const installed = asObject(
      asObject(await readJson(path.join(root, "installed_plugins.json")))?.plugins,
    );
    for (const [pluginId, records] of Object.entries(installed ?? {})) {
      if (enabled.get(pluginId) !== true) continue;
      const record = toList(records)
        .map(asObject)
        .find((r) => typeof r?.installPath === "string");
      const installPath = record?.installPath as string | undefined;
      if (!installPath || !(await isDir(installPath))) continue;
      const scope: PluginScope =
        record?.scope === "project" || record?.scope === "local" ? "project" : "user";
      // A project-scoped install belongs to one repository only.
      if (scope === "project") {
        const projectPath =
          typeof record?.projectPath === "string" ? record.projectPath : undefined;
        if (!options.cwd || !projectPath || path.resolve(projectPath) !== path.resolve(options.cwd))
          continue;
      }
      const [fallback = pluginId] = pluginId.split("@");
      add(await loadPlugin(installPath, fallback, () => pluginId, scope, dataRoot));
    }

    // Skills-directory plugins, the user's before the project's: on a name
    // clash the user's own copy wins over one a repository brings.
    const dirs: Array<[string, PluginScope]> = [[path.join(claudeHome, "skills"), "user"]];
    if (options.cwd) dirs.push([path.join(options.cwd, ".claude", "skills"), "project"]);
    for (const [dir, scope] of dirs) {
      for (const pluginRoot of await skillsDirPlugins(dir)) {
        const plugin = await loadPlugin(
          pluginRoot,
          path.basename(pluginRoot),
          (name) => `${name}@skills-dir`,
          scope,
          dataRoot,
        );
        if (!plugin) continue;
        const manifest = ((await readJson(
          path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        )) ?? {}) as Manifest;
        const setting = enabled.get(plugin.id);
        const on = setting ?? manifest.defaultEnabled !== false;
        if (on) add(plugin);
      }
    }
  } catch (err) {
    log("WARN", "plugins", "Claude plugin discovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return plugins;
}

// Claude Code tool names in agent `tools:` lists, mapped to ours. Names with no
// counterpart (NotebookEdit, …) are dropped; MCP names already match.
const CLAUDE_TOOL_NAMES: Record<string, string[]> = {
  read: ["read"],
  write: ["write"],
  edit: ["edit"],
  multiedit: ["edit"],
  grep: ["grep"],
  glob: ["find"],
  ls: ["ls"],
  bash: ["bash"],
  bashoutput: ["task_output"],
  killshell: ["task_stop"],
  webfetch: ["web_fetch"],
  websearch: ["web_search"],
  task: ["spawn_agent", "wait_agent"],
  agent: ["spawn_agent", "wait_agent"],
  todowrite: ["todo_write"],
  skill: ["skill"],
};

/** Translate a Claude agent's tool list; empty (inherit everything) stays empty. */
export function mapClaudeTools(tools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) {
    if (tool.startsWith("mcp__")) out.add(tool);
    else for (const ours of CLAUDE_TOOL_NAMES[tool.toLowerCase()] ?? [tool]) out.add(ours);
  }
  return [...out];
}

/** Agents from enabled plugins, named `plugin:agent` like Claude Code does. */
export async function loadPluginAgents(
  plugins: readonly ClaudePlugin[],
): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];
  for (const plugin of plugins) {
    for (const file of plugin.agentFiles) {
      try {
        const agent = parseAgentFile(
          await fs.readFile(file, "utf-8"),
          plugin.scope === "project" ? "project" : "global",
        );
        agent.name = `${plugin.name}:${agent.name || path.basename(file, ".md")}`;
        agent.tools = mapClaudeTools(agent.tools);
        // Claude's sonnet/opus/haiku aliases aren't model ids here.
        if (agent.model && /^(sonnet|opus|haiku|inherit|default)$/i.test(agent.model))
          agent.model = "inherit";
        validateAgentTools(agent, file);
        agents.push(agent);
      } catch {
        // Skip unreadable agent files.
      }
    }
  }
  return agents;
}

/** Slash commands from enabled plugins, named `plugin:command`. */
export async function loadPluginCommands(
  plugins: readonly ClaudePlugin[],
): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];
  for (const plugin of plugins) {
    for (const entry of plugin.commandFiles) {
      try {
        const raw = entry.content ?? (entry.file ? await fs.readFile(entry.file, "utf-8") : "");
        const parsed = parseSkillFile(raw, plugin.scope === "project" ? "project" : "global");
        commands.push({
          name: `${plugin.name}:${entry.name}`,
          description: entry.description || parsed.description || `From the ${plugin.name} plugin`,
          prompt: parsed.content,
          filePath: entry.file ?? path.join(plugin.root, ".claude-plugin", "plugin.json"),
        });
      } catch {
        // Skip unreadable command files.
      }
    }
  }
  return commands;
}
