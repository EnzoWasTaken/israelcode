import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultHooksConfig,
  detectFormatCommand,
  detectLintCommand,
  hookFilePaths,
  isDangerousCommand,
  loadHooksConfig,
  matchesProtectedPath,
  normalizeHooksConfig,
  resolveHooksForTool,
  resolveStopHooks,
  saveHooksConfig,
  substituteHookCommand,
  type HooksConfig,
} from "./hook-presets.js";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-hooks-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function withPresets(
  overrides: Partial<HooksConfig["presets"]>,
  custom: HooksConfig["custom"] = [],
) {
  const cfg = defaultHooksConfig();
  cfg.presets = { ...cfg.presets, ...overrides };
  cfg.custom = custom;
  return cfg;
}

describe("hooks config", () => {
  it("defaults to everything off and round-trips through .gg/hooks.json", async () => {
    expect(await loadHooksConfig(cwd)).toEqual(defaultHooksConfig());
    const saved = await saveHooksConfig(cwd, {
      version: 1,
      presets: {
        formatOnEdit: { enabled: true, command: "  prettier --write {file} " },
        protectPaths: { enabled: true, globs: ["*.lock", "", " .github/** "] },
        blockDangerous: { enabled: "yes" },
      },
      custom: [
        { id: "a", event: "postToolUse", tool: "edit", command: "echo hi", timeoutMs: 5 },
        { id: "a", event: "stop", command: "dup" },
        { id: "", event: "stop", command: "x" },
        { id: "b", event: "nope", command: "x" },
        { id: "c", event: "stop", command: "   " },
        { id: "d", event: "stop", command: "notify", timeoutMs: 99_999_999 },
      ],
    });
    expect(saved).toEqual({
      version: 1,
      presets: {
        formatOnEdit: { enabled: true, command: "prettier --write {file}" },
        lintOnEdit: { enabled: false },
        protectPaths: { enabled: true, globs: ["*.lock", ".github/**"] },
        blockDangerous: { enabled: false },
        notifyOnFinish: { enabled: false },
      },
      custom: [
        { id: "a", event: "postToolUse", tool: "edit", command: "echo hi", timeoutMs: 5 },
        { id: "d", event: "stop", command: "notify", timeoutMs: 600_000 },
      ],
    });
    expect(await loadHooksConfig(cwd)).toEqual(saved);
    expect(JSON.parse(await fs.readFile(path.join(cwd, ".gg", "hooks.json"), "utf-8"))).toEqual(
      saved,
    );
  });

  it("treats a malformed file like no file", async () => {
    await fs.mkdir(path.join(cwd, ".gg"));
    await fs.writeFile(path.join(cwd, ".gg", "hooks.json"), "{not json");
    expect(await loadHooksConfig(cwd)).toEqual(defaultHooksConfig());
    expect(normalizeHooksConfig(null)).toEqual(defaultHooksConfig());
    expect(normalizeHooksConfig([1])).toEqual(defaultHooksConfig());
  });
});

describe("formatter and linter detection", () => {
  it("picks prettier with the project's runner and eslint for report only", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ devDependencies: { prettier: "3", eslint: "9" } }),
    );
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "");
    expect(detectFormatCommand(cwd, path.join(cwd, "src", "a.ts"))).toBe(
      'pnpm exec prettier --write "src/a.ts"'.replaceAll("/", path.sep === "\\" ? "\\" : "/"),
    );
    expect(detectLintCommand(cwd, "src/a.tsx")).toBe(
      'pnpm exec eslint "src/a.tsx"'.replaceAll("/", path.sep === "\\" ? "\\" : "/"),
    );
    expect(detectLintCommand(cwd, "README.md")).toBeNull();
    expect(detectFormatCommand(cwd, "main.rs")).toBeNull();
  });

  it("uses npx without a lockfile and an rc file as evidence", async () => {
    await fs.writeFile(path.join(cwd, ".prettierrc"), "{}");
    await fs.writeFile(path.join(cwd, "eslint.config.js"), "");
    expect(detectFormatCommand(cwd, "a.js")).toBe('npx prettier --write "a.js"');
    expect(detectLintCommand(cwd, "a.js")).toBe('npx eslint "a.js"');
  });

  it("knows rustfmt, ruff, black and gofmt", async () => {
    await fs.writeFile(path.join(cwd, "Cargo.toml"), "");
    await fs.writeFile(path.join(cwd, "go.mod"), "");
    await fs.writeFile(path.join(cwd, "pyproject.toml"), "[tool.black]\n");
    expect(detectFormatCommand(cwd, "src/lib.rs")).toBe(`rustfmt "${path.join("src", "lib.rs")}"`);
    expect(detectFormatCommand(cwd, "main.go")).toBe('gofmt -w "main.go"');
    expect(detectFormatCommand(cwd, "x.py")).toBe('black "x.py"');
    expect(detectLintCommand(cwd, "x.py")).toBeNull();
    await fs.writeFile(path.join(cwd, "pyproject.toml"), "[tool.ruff]\n");
    expect(detectFormatCommand(cwd, "x.py")).toBe('ruff format "x.py"');
    expect(detectLintCommand(cwd, "x.py")).toBe('ruff check "x.py"');
  });

  it("substitutes {file} and {tool} or appends the file", () => {
    expect(substituteHookCommand("fmt {file} --by {tool}", { file: "a b.ts", tool: "edit" })).toBe(
      'fmt "a b.ts" --by edit',
    );
    expect(substituteHookCommand("fmt", { file: "a.ts" }, true)).toBe('fmt "a.ts"');
    expect(substituteHookCommand("fmt", { file: "a.ts" })).toBe("fmt");
  });
});

describe("matchesProtectedPath", () => {
  it("matches globs against the project-relative path", () => {
    expect(matchesProtectedPath("pnpm-lock.yaml", ["*.lock", "pnpm-lock.yaml"], cwd)).toBe(true);
    expect(
      matchesProtectedPath(path.join(cwd, ".github", "workflows", "ci.yml"), [".github/**"], cwd),
    ).toBe(true);
    expect(matchesProtectedPath("src/gen/x.ts", ["src/gen"], cwd)).toBe(true);
    expect(matchesProtectedPath("src/gen/x.ts", ["src/gen/"], cwd)).toBe(true);
    expect(matchesProtectedPath("deep/a/b/.env", [".env"], cwd)).toBe(true);
    expect(matchesProtectedPath("src/x.test.ts", ["**/*.{test,spec}.ts"], cwd)).toBe(true);
    expect(matchesProtectedPath("src/x.ts", ["**/*.{test,spec}.ts"], cwd)).toBe(false);
    expect(matchesProtectedPath("src/x.ts", ["src/*.js", "??.ts"], cwd)).toBe(false);
    expect(matchesProtectedPath("src/x.ts", [], cwd)).toBe(false);
    expect(matchesProtectedPath("src/x.ts", ["*.ts"], cwd)).toBe(true);
    expect(matchesProtectedPath("src/x.ts", ["/*.ts"], cwd)).toBe(false);
  });

  it("matches a file outside the project only by its absolute path", () => {
    const outside = path.resolve(cwd, "..", "elsewhere", "secret.env");
    expect(matchesProtectedPath(outside, ["*.env"], cwd)).toBe(true);
    expect(matchesProtectedPath(outside, ["elsewhere/secret.env"], cwd)).toBe(false);
  });
});

describe("isDangerousCommand", () => {
  it("blocks destructive git, catastrophic and outside removals, and publishing", () => {
    expect(isDangerousCommand("git push --force origin main", cwd).blocked).toBe(true);
    expect(isDangerousCommand("git reset --hard HEAD~1", cwd)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("reset-hard"),
    });
    expect(isDangerousCommand("git clean -fd", cwd).blocked).toBe(true);
    expect(isDangerousCommand("git branch -D feature", cwd).blocked).toBe(true);
    expect(isDangerousCommand("git checkout -- src/a.ts", cwd).blocked).toBe(true);
    expect(isDangerousCommand("rm -rf /", cwd).blocked).toBe(true);
    expect(isDangerousCommand("rm -rf ../other", cwd)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("outside the project"),
    });
    expect(isDangerousCommand("rm -rf ~/stuff", cwd).blocked).toBe(true);
    expect(isDangerousCommand("npm publish", cwd)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("npm publish"),
    });
    expect(isDangerousCommand("pnpm test && pnpm publish --access public", cwd).blocked).toBe(true);
    expect(isDangerousCommand("npx changeset publish", cwd).blocked).toBe(true);
    expect(isDangerousCommand("cargo publish", cwd).blocked).toBe(true);
    expect(isDangerousCommand("gh release create v1", cwd).blocked).toBe(true);
    expect(isDangerousCommand("yarn npm publish", cwd).blocked).toBe(true);
    expect(isDangerousCommand("docker push me/img", cwd).blocked).toBe(true);
  });

  it("lets ordinary commands through", () => {
    expect(isDangerousCommand("git status && git log --oneline", cwd)).toEqual({ blocked: false });
    expect(isDangerousCommand("git push origin main", cwd).blocked).toBe(false);
    expect(isDangerousCommand("rm -rf node_modules dist", cwd).blocked).toBe(false);
    expect(isDangerousCommand("rm file.txt", cwd).blocked).toBe(false);
    expect(isDangerousCommand("npm run publish:docs", cwd).blocked).toBe(false);
    expect(isDangerousCommand("npm view react version", cwd).blocked).toBe(false);
    expect(isDangerousCommand("gh release list", cwd).blocked).toBe(false);
    expect(isDangerousCommand("docker build .", cwd).blocked).toBe(false);
    expect(isDangerousCommand("npx prettier --write a.ts", cwd).blocked).toBe(false);
  });
});

describe("resolveHooksForTool", () => {
  it("reads file paths from write and edit arguments", () => {
    expect(hookFilePaths("write", { file_path: "a.ts", content: "" })).toEqual(["a.ts"]);
    expect(
      hookFilePaths("edit", {
        files: [{ file_path: "a.ts" }, { file_path: "b.ts" }, { file_path: "a.ts" }],
      }),
    ).toEqual(["a.ts", "b.ts"]);
    expect(hookFilePaths("bash", { command: "ls" })).toEqual([]);
    expect(hookFilePaths("read", { file_path: "a.ts" })).toEqual([]);
  });

  it("blocks protected paths and dangerous commands before the tool runs", () => {
    const cfg = withPresets({
      protectPaths: { enabled: true, globs: ["*.lock"] },
      blockDangerous: { enabled: true },
    });
    const write = resolveHooksForTool(cfg, "write", { file_path: "yarn.lock" }, cwd);
    expect(write.pre).toEqual([
      expect.objectContaining({
        id: "protectPaths",
        kind: "block",
        reason: expect.stringContaining("yarn.lock"),
      }),
    ]);
    expect(write.post).toEqual([]);
    expect(resolveHooksForTool(cfg, "write", { file_path: "src/a.ts" }, cwd).pre).toEqual([]);
    const bash = resolveHooksForTool(cfg, "bash", { command: "git reset --hard" }, cwd);
    expect(bash.pre).toEqual([expect.objectContaining({ id: "blockDangerous", kind: "block" })]);
    expect(resolveHooksForTool(cfg, "bash", { command: "ls" }, cwd).pre).toEqual([]);
    // Off: nothing resolves.
    expect(resolveHooksForTool(defaultHooksConfig(), "bash", { command: "rm -rf /" }, cwd)).toEqual(
      {
        pre: [],
        post: [],
      },
    );
  });

  it("runs format then lint after an edit with the detected or overridden command", async () => {
    await fs.writeFile(path.join(cwd, ".prettierrc"), "{}");
    const cfg = withPresets({
      formatOnEdit: { enabled: true },
      lintOnEdit: { enabled: true, command: "mylint {file}" },
    });
    const { pre, post } = resolveHooksForTool(cfg, "edit", { file_path: "a.ts", edits: [] }, cwd);
    expect(pre).toEqual([]);
    expect(post).toEqual([
      {
        id: "formatOnEdit",
        label: "format",
        kind: "run",
        command: 'npx prettier --write "a.ts"',
        timeoutMs: 60_000,
      },
      { id: "lintOnEdit", label: "lint", kind: "run", command: 'mylint "a.ts"', timeoutMs: 60_000 },
    ]);
    // No formatter for the file kind: the format hook is skipped quietly.
    expect(resolveHooksForTool(cfg, "write", { file_path: "a.rs" }, cwd).post).toEqual([
      expect.objectContaining({ id: "lintOnEdit" }),
    ]);
  });

  it("includes custom hooks filtered by event and tool, and stop hooks", () => {
    const cfg = withPresets({}, [
      { id: "pre-all", event: "preToolUse", command: "check {tool}" },
      {
        id: "post-edit",
        event: "postToolUse",
        tool: "edit",
        command: "after {file}",
        timeoutMs: 1000,
      },
      { id: "done", event: "stop", command: "say done" },
    ]);
    const edit = resolveHooksForTool(cfg, "edit", { file_path: "a.ts" }, cwd);
    expect(edit.pre).toEqual([
      { id: "pre-all", label: "pre-all", kind: "run", command: "check edit", timeoutMs: 60_000 },
    ]);
    expect(edit.post).toEqual([
      {
        id: "post-edit",
        label: "post-edit",
        kind: "run",
        command: 'after "a.ts"',
        timeoutMs: 1000,
      },
    ]);
    const bash = resolveHooksForTool(cfg, "bash", { command: "ls" }, cwd);
    expect(bash.pre.map((a) => a.command)).toEqual(["check bash"]);
    expect(bash.post).toEqual([]);
    expect(resolveStopHooks(cfg)).toEqual([
      { id: "done", label: "done", kind: "run", command: "say done", timeoutMs: 60_000 },
    ]);
  });
});
