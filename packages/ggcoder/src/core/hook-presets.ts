import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  expandShellPath,
  findDestructiveGitCommands,
  hasLong,
  hasShort,
  walkShell,
} from "./destructive-git-guard.js";
import { detectNodeRunner } from "./verify-commands.js";
import { isCatastrophicCommand } from "./workspace-guard.js";

/**
 * Hook presets: the five shell hooks every user hand-writes (format after
 * edit, lint after edit, protect paths, block dangerous commands, notify when
 * done) as one-click switches per project, plus `custom` command hooks for
 * power users (exit code 2 = block, stderr shown to the model). The config
 * lives in `<project>/.gg/hooks.json` and is shared through git; the on/off
 * switch for the whole feature lives in `~/.israelcode/gg-app.json`.
 *
 * Pure module: reads manifests, never runs anything. `core/hook-wrap.ts`
 * applies the resolved actions around tool calls.
 */

export const HOOKS_CONFIG_FILE = path.join(".gg", "hooks.json");

export type HookEventName = "preToolUse" | "postToolUse" | "stop";

export interface CustomHook {
  id: string;
  event: HookEventName;
  /** Only for this tool (name); absent = every tool the event covers. */
  tool?: string;
  /** Shell command; `{file}` and `{tool}` are substituted. */
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  version: 1;
  presets: {
    formatOnEdit: { enabled: boolean; command?: string };
    lintOnEdit: { enabled: boolean; command?: string };
    protectPaths: { enabled: boolean; globs: string[] };
    blockDangerous: { enabled: boolean };
    notifyOnFinish: { enabled: boolean };
  };
  custom: CustomHook[];
}

export interface HookAction {
  id: string;
  label: string;
  kind: "block" | "run";
  /** `block`: why, as shown to the model. */
  reason?: string;
  /** `run`: the command, placeholders already substituted. */
  command?: string;
  timeoutMs: number;
}

/** Default and ceiling for a command hook. */
export const HOOK_TIMEOUT_MS = 60_000;
export const HOOK_TIMEOUT_MAX_MS = 10 * 60_000;

/** Tools whose arguments name files they change. */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "apply_patch",
]);

/** Everything off: the user opts in per preset. */
export function defaultHooksConfig(): HooksConfig {
  return {
    version: 1,
    presets: {
      formatOnEdit: { enabled: false },
      lintOnEdit: { enabled: false },
      protectPaths: { enabled: false, globs: [] },
      blockDangerous: { enabled: false },
      notifyOnFinish: { enabled: false },
    },
    custom: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalCommand(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeHookTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return HOOK_TIMEOUT_MS;
  return Math.min(Math.round(value), HOOK_TIMEOUT_MAX_MS);
}

/**
 * Coerce anything (a parsed file, a request body) into a valid config:
 * unknown presets fall back to off, malformed custom entries are dropped,
 * duplicate custom ids keep the first.
 */
export function normalizeHooksConfig(raw: unknown): HooksConfig {
  const out = defaultHooksConfig();
  if (!isRecord(raw)) return out;
  const presets = isRecord(raw.presets) ? raw.presets : {};
  const flag = (key: keyof HooksConfig["presets"]): boolean => {
    const p = presets[key];
    return isRecord(p) && p.enabled === true;
  };
  const command = (key: "formatOnEdit" | "lintOnEdit"): string | undefined => {
    const p = presets[key];
    return isRecord(p) ? optionalCommand(p.command) : undefined;
  };
  const fmt = command("formatOnEdit");
  const lint = command("lintOnEdit");
  out.presets.formatOnEdit = { enabled: flag("formatOnEdit"), ...(fmt ? { command: fmt } : {}) };
  out.presets.lintOnEdit = { enabled: flag("lintOnEdit"), ...(lint ? { command: lint } : {}) };
  const protect = presets.protectPaths;
  const globs =
    isRecord(protect) && Array.isArray(protect.globs)
      ? protect.globs
          .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
          .map((g) => g.trim())
      : [];
  out.presets.protectPaths = { enabled: flag("protectPaths"), globs };
  out.presets.blockDangerous = { enabled: flag("blockDangerous") };
  out.presets.notifyOnFinish = { enabled: flag("notifyOnFinish") };
  if (Array.isArray(raw.custom)) {
    const seen = new Set<string>();
    for (const entry of raw.custom) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const event = entry.event;
      const cmd = optionalCommand(entry.command);
      if (!id || seen.has(id) || !cmd) continue;
      if (event !== "preToolUse" && event !== "postToolUse" && event !== "stop") continue;
      seen.add(id);
      const tool = optionalCommand(entry.tool);
      out.custom.push({
        id,
        event,
        ...(tool ? { tool } : {}),
        command: cmd,
        ...(entry.timeoutMs !== undefined
          ? { timeoutMs: normalizeHookTimeout(entry.timeoutMs) }
          : {}),
      });
    }
  }
  return out;
}

/** Read `<cwd>/.gg/hooks.json`; missing or malformed → everything off. */
export async function loadHooksConfig(cwd: string): Promise<HooksConfig> {
  const raw = await fsp
    .readFile(path.join(cwd, HOOKS_CONFIG_FILE), "utf-8")
    .catch((): null => null);
  if (raw === null) return defaultHooksConfig();
  try {
    return normalizeHooksConfig(JSON.parse(raw));
  } catch {
    return defaultHooksConfig();
  }
}

/** Write `<cwd>/.gg/hooks.json` (shared through git); returns the normalized config. */
export async function saveHooksConfig(cwd: string, config: unknown): Promise<HooksConfig> {
  const normalized = normalizeHooksConfig(config);
  const target = path.join(cwd, HOOKS_CONFIG_FILE);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return normalized;
}

// ── Formatter / linter detection (file-scoped, manifest reads only) ──────────

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function packageDeps(cwd: string): Set<string> {
  const raw = readFileSafe(path.join(cwd, "package.json"));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const names: string[] = [];
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const block = parsed[key];
      if (isRecord(block)) names.push(...Object.keys(block));
    }
    return new Set(names);
  } catch {
    return new Set();
  }
}

/** `pnpm exec` / `yarn` / `bunx` / `npx` for a package binary. */
function nodeExec(cwd: string): string {
  const runner = detectNodeRunner(cwd);
  if (runner === "pnpm") return "pnpm exec";
  if (runner === "yarn") return "yarn";
  if (runner === "bun") return "bunx";
  return "npx";
}

const PRETTIER_RC = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];
const ESLINT_RC = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];
const PRETTIER_EXT = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".graphql",
]);
const ESLINT_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"]);

function hasPrettier(cwd: string): boolean {
  if (packageDeps(cwd).has("prettier")) return true;
  if (PRETTIER_RC.some((f) => fileExists(path.join(cwd, f)))) return true;
  const raw = readFileSafe(path.join(cwd, "package.json"));
  return raw !== null && /"prettier"\s*:/.test(raw);
}

function hasEslint(cwd: string): boolean {
  return packageDeps(cwd).has("eslint") || ESLINT_RC.some((f) => fileExists(path.join(cwd, f)));
}

/** Quote a path for the user's shell (double quotes work in bash, cmd and PowerShell). */
export function quoteShellPath(p: string): string {
  return `"${p.replaceAll('"', '\\"')}"`;
}

/** The file as the hook's command sees it: relative to the project when inside it. */
export function hookFileArg(cwd: string, filePath: string): string {
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

/**
 * The formatter command for one file, or null when the project shows no
 * formatter for its kind (prettier via deps/rc; rustfmt; ruff/black from
 * pyproject; gofmt). File-scoped: `cargo fmt` takes no file, so `rustfmt`.
 */
export function detectFormatCommand(cwd: string, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const file = quoteShellPath(hookFileArg(cwd, filePath));
  if (PRETTIER_EXT.has(ext) && hasPrettier(cwd)) {
    return `${nodeExec(cwd)} prettier --write ${file}`;
  }
  if (ext === ".rs" && fileExists(path.join(cwd, "Cargo.toml"))) return `rustfmt ${file}`;
  if (ext === ".py") {
    const pyproject = readFileSafe(path.join(cwd, "pyproject.toml")) ?? "";
    if (/\[tool\.ruff/.test(pyproject) || /\bruff\b/.test(pyproject)) {
      return `ruff format ${file}`;
    }
    if (/\[tool\.black/.test(pyproject) || /\bblack\b/.test(pyproject)) return `black ${file}`;
    return null;
  }
  if (ext === ".go" && fileExists(path.join(cwd, "go.mod"))) return `gofmt -w ${file}`;
  return null;
}

/**
 * The linter command for one file (report only, never `--fix`), or null.
 * eslint via deps/rc; ruff check from pyproject. Clippy is too slow per file.
 */
export function detectLintCommand(cwd: string, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const file = quoteShellPath(hookFileArg(cwd, filePath));
  if (ESLINT_EXT.has(ext) && hasEslint(cwd)) return `${nodeExec(cwd)} eslint ${file}`;
  if (ext === ".py") {
    const pyproject = readFileSafe(path.join(cwd, "pyproject.toml")) ?? "";
    if (/\[tool\.ruff/.test(pyproject) || /\bruff\b/.test(pyproject)) return `ruff check ${file}`;
  }
  return null;
}

/**
 * Fill a user command: `{file}` → quoted path, `{tool}` → tool name. With
 * `appendFile` (the format/lint presets) a command without `{file}` gets the
 * file appended, so "prettier --write" works as written.
 */
export function substituteHookCommand(
  command: string,
  vars: { file?: string; tool?: string },
  appendFile = false,
): string {
  let out = command.replaceAll("{tool}", vars.tool ?? "");
  if (vars.file !== undefined) {
    const quoted = quoteShellPath(vars.file);
    out = out.includes("{file}")
      ? out.replaceAll("{file}", quoted)
      : appendFile
        ? `${out} ${quoted}`
        : out;
  }
  return out;
}

// ── Protected paths ──────────────────────────────────────────────────────────

/** Glob → RegExp over `/`-separated relative paths: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  // A bare name or directory glob matches at any depth, like .gitignore.
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else if (/[.+^$()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/**
 * Does `filePath` (absolute or relative to `cwd`) fall under any of `globs`?
 * A glob matches the file's project-relative path; a matching directory
 * protects everything below it. Files outside the project match only
 * absolute-looking globs against the absolute path.
 */
export function matchesProtectedPath(
  filePath: string,
  globs: readonly string[],
  cwd: string,
): boolean {
  if (globs.length === 0) return false;
  const abs = path.resolve(cwd, filePath);
  const relRaw = path.relative(cwd, abs);
  const inside = relRaw !== "" && !relRaw.startsWith("..") && !path.isAbsolute(relRaw);
  const rel = inside ? relRaw.replaceAll("\\", "/") : null;
  const absSlash = abs.replaceAll("\\", "/");
  for (const glob of globs) {
    const re = globToRegExp(glob);
    const candidates = rel === null ? [absSlash] : [rel, absSlash];
    for (const candidate of candidates) {
      if (re.test(candidate)) return true;
      // A directory pattern (`.github`, `src/gen`) covers its contents.
      const parts = candidate.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (re.test(parts.slice(0, i).join("/"))) return true;
      }
    }
  }
  return false;
}

// ── Dangerous commands ───────────────────────────────────────────────────────

/** Commands that publish or change a registry/release: `name sub [second]`. */
const PUBLISH_RULES: ReadonlyArray<readonly string[]> = [
  ["npm", "publish"],
  ["npm", "unpublish"],
  ["npm", "deprecate"],
  ["npm", "dist-tag"],
  ["pnpm", "publish"],
  ["pnpm", "unpublish"],
  ["pnpm", "deprecate"],
  ["yarn", "publish"],
  ["yarn", "npm", "publish"],
  ["bun", "publish"],
  ["cargo", "publish"],
  ["cargo", "yank"],
  ["twine", "upload"],
  ["gem", "push"],
  ["gem", "yank"],
  ["docker", "push"],
  ["nuget", "push"],
  ["nuget", "delete"],
  ["dotnet", "nuget", "push"],
  ["dotnet", "nuget", "delete"],
  ["gh", "release", "create"],
  ["gh", "release", "upload"],
  ["changeset", "publish"],
  ["uv", "publish"],
  ["poetry", "publish"],
  ["flit", "publish"],
];

const INSPECTED = new Set(["rm", "npx", "pnpx", "bunx", ...PUBLISH_RULES.map((r) => r[0]!)]);

/** The publish rule `words` (command name then non-option args) matches, or null. */
function matchPublishRule(words: readonly string[]): string | null {
  for (const rule of PUBLISH_RULES) {
    if (rule.every((w, i) => (words[i] ?? "").toLowerCase() === w)) return rule.join(" ");
  }
  return null;
}

function isUnderProject(target: string, cwd: string): boolean {
  const rel = path.relative(path.resolve(cwd), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The blockDangerous preset: is `command` one that destroys work or ships
 * something? Reuses the workspace guard (catastrophic removals) and the git
 * guard's parser (force-push, reset --hard, clean -fd, branch -D, checkout --
 * …, always blocked here, not only when uncommitted work exists), and adds
 * `rm -r` outside the project and package publish/registry commands.
 */
export function isDangerousCommand(
  command: string,
  cwd: string,
): { blocked: boolean; reason?: string } {
  const catastrophic = isCatastrophicCommand(command, cwd);
  if (catastrophic) return { blocked: true, reason: catastrophic };
  if (/\bgit\b/.test(command)) {
    const git = findDestructiveGitCommands(command, cwd);
    const first = git[0];
    if (first) {
      return {
        blocked: true,
        reason: `destructive git command (${first.kind}): ${first.display}`,
      };
    }
  }
  for (const call of walkShell(command, cwd, (name) => INSPECTED.has(name.toLowerCase()))) {
    const name = call.name.toLowerCase();
    if (name === "rm") {
      const args = [...call.args];
      if (!hasShort(args, "r") && !hasShort(args, "R") && !hasLong(args, "--recursive")) continue;
      for (const arg of args) {
        if (arg.startsWith("-")) continue;
        const target = path.resolve(call.cwd, expandShellPath(arg, call.cwd));
        if (!isUnderProject(target, cwd)) {
          return { blocked: true, reason: `recursive removal outside the project: ${arg}` };
        }
      }
      continue;
    }
    // `npx changeset publish`, `pnpx …`: the package being run is the command.
    const positional = call.args.filter((a) => !a.startsWith("-"));
    const words =
      name === "npx" || name === "pnpx" || name === "bunx" ? positional : [name, ...positional];
    const rule = matchPublishRule(words);
    if (rule) return { blocked: true, reason: `publishes or changes a registry/release: ${rule}` };
  }
  return { blocked: false };
}

// ── Resolution per tool call ─────────────────────────────────────────────────

/** The file paths a mutating tool call names (`file_path`, `files[].file_path`, …). */
export function hookFilePaths(toolName: string, args: unknown): string[] {
  if (!FILE_MUTATING_TOOLS.has(toolName) || !isRecord(args)) return [];
  const out: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof args[key] === "string" && (args[key] as string).trim())
      out.push(args[key] as string);
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (isRecord(f) && typeof f.file_path === "string" && f.file_path.trim()) {
        out.push(f.file_path);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The actions to take before and after one tool call, from the config. Pre
 * actions may block (`kind: "block"`); run actions carry a ready command.
 */
export function resolveHooksForTool(
  config: HooksConfig,
  toolName: string,
  args: unknown,
  cwd: string,
): { pre: HookAction[]; post: HookAction[] } {
  const pre: HookAction[] = [];
  const post: HookAction[] = [];
  const files = hookFilePaths(toolName, args);
  const { presets } = config;

  if (presets.protectPaths.enabled && files.length > 0) {
    const hit = files.find((f) => matchesProtectedPath(f, presets.protectPaths.globs, cwd));
    if (hit) {
      pre.push({
        id: "protectPaths",
        label: "Protected paths",
        kind: "block",
        reason: `${hookFileArg(cwd, hit)} is a protected path (hooks.json protectPaths). Ask the user before changing it.`,
        timeoutMs: 0,
      });
    }
  }

  if (presets.blockDangerous.enabled && toolName === "bash" && isRecord(args)) {
    const command = typeof args.command === "string" ? args.command : "";
    const verdict = command ? isDangerousCommand(command, cwd) : { blocked: false };
    if (verdict.blocked) {
      pre.push({
        id: "blockDangerous",
        label: "Block dangerous commands",
        kind: "block",
        reason: `${verdict.reason ?? "dangerous command"} (hooks.json blockDangerous). Ask the user to run it themselves.`,
        timeoutMs: 0,
      });
    }
  }

  const custom = (event: HookEventName): CustomHook[] =>
    config.custom.filter((h) => h.event === event && (!h.tool || h.tool === toolName));
  const customActions = (event: HookEventName): HookAction[] =>
    custom(event).map((h) => ({
      id: h.id,
      label: h.id,
      kind: "run" as const,
      command: substituteHookCommand(h.command, {
        tool: toolName,
        ...(files[0] ? { file: hookFileArg(cwd, files[0]) } : {}),
      }),
      timeoutMs: normalizeHookTimeout(h.timeoutMs),
    }));
  pre.push(...customActions("preToolUse"));

  if (files.length > 0) {
    for (const file of files) {
      if (presets.formatOnEdit.enabled) {
        const command = presets.formatOnEdit.command
          ? substituteHookCommand(
              presets.formatOnEdit.command,
              { file: hookFileArg(cwd, file), tool: toolName },
              true,
            )
          : detectFormatCommand(cwd, file);
        if (command) {
          post.push({
            id: "formatOnEdit",
            label: "format",
            kind: "run",
            command,
            timeoutMs: HOOK_TIMEOUT_MS,
          });
        }
      }
      if (presets.lintOnEdit.enabled) {
        const command = presets.lintOnEdit.command
          ? substituteHookCommand(
              presets.lintOnEdit.command,
              { file: hookFileArg(cwd, file), tool: toolName },
              true,
            )
          : detectLintCommand(cwd, file);
        if (command) {
          post.push({
            id: "lintOnEdit",
            label: "lint",
            kind: "run",
            command,
            timeoutMs: HOOK_TIMEOUT_MS,
          });
        }
      }
    }
  }
  post.push(...customActions("postToolUse"));
  return { pre, post };
}

/** The `stop` hooks to run when a user-initiated run ends. */
export function resolveStopHooks(config: HooksConfig): HookAction[] {
  return config.custom
    .filter((h) => h.event === "stop")
    .map((h) => ({
      id: h.id,
      label: h.id,
      kind: "run" as const,
      command: substituteHookCommand(h.command, { tool: "stop" }),
      timeoutMs: normalizeHookTimeout(h.timeoutMs),
    }));
}
