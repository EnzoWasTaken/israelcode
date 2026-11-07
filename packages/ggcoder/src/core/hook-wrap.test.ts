import type { AgentTool } from "@kenkaiiii/gg-agent";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultHooksConfig, type HooksConfig } from "./hook-presets.js";
import {
  appendToResult,
  lastLines,
  wrapWithHooks,
  type HookEvent,
  type HooksRuntime,
} from "./hook-wrap.js";

const cwd = path.join(os.tmpdir(), "gg-hook-wrap-proj");

function fakeTool(name: string, result: unknown = "ok", timeoutMs?: number) {
  const execute = vi.fn(async () => result as string);
  const tool = {
    name,
    description: "d",
    parameters: z.object({}).passthrough(),
    execute,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  } as unknown as AgentTool;
  return { tool, execute };
}

function runtime(
  config: HooksConfig,
  runs: Record<string, { exitCode: number | null; tail: string }> = {},
): HooksRuntime & { events: HookEvent[]; runCommand: ReturnType<typeof vi.fn> } {
  const events: HookEvent[] = [];
  const runCommand = vi.fn(async (command: string) => {
    const hit = Object.entries(runs).find(([key]) => command.includes(key));
    if (hit) return hit[1];
    return { exitCode: 0, tail: "" };
  });
  return { config, cwd, runCommand, onEvent: (ev) => events.push(ev), events };
}

const ctx = () => ({ signal: new AbortController().signal, toolCallId: "t1" });

describe("wrapWithHooks", () => {
  it("leaves tools no hook covers and keeps name/schema of wrapped ones", () => {
    const { tool } = fakeTool("read");
    expect(wrapWithHooks(tool, () => undefined)).toBe(tool);
    const { tool: write } = fakeTool("write", "ok", 1000);
    const wrapped = wrapWithHooks(write, () => undefined);
    expect(wrapped.name).toBe("write");
    expect(wrapped.description).toBe(write.description);
    expect(wrapped.parameters).toBe(write.parameters);
    expect(wrapped.timeoutMs).toBeGreaterThan(1000);
  });

  it("runs the tool untouched when hooks are off or the getter throws", async () => {
    const { tool, execute } = fakeTool("bash");
    expect(await wrapWithHooks(tool, () => undefined).execute({ command: "rm -rf /" }, ctx())).toBe(
      "ok",
    );
    expect(
      await wrapWithHooks(tool, () => {
        throw new Error("boom");
      }).execute({ command: "x" }, ctx()),
    ).toBe("ok");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("blocks a protected path and a dangerous command without running the tool", async () => {
    const config = defaultHooksConfig();
    config.presets.protectPaths = { enabled: true, globs: ["*-lock.yaml"] };
    config.presets.blockDangerous = { enabled: true };
    const rt = runtime(config);
    const { tool: write, execute } = fakeTool("write");
    const result = await wrapWithHooks(write, () => rt).execute(
      { file_path: "pnpm-lock.yaml", content: "" },
      ctx(),
    );
    expect(result).toMatch(/^Error: blocked by hook protectPaths: .*pnpm-lock\.yaml/);
    expect(execute).not.toHaveBeenCalled();
    const { tool: bash, execute: runBash } = fakeTool("bash");
    expect(
      await wrapWithHooks(bash, () => rt).execute({ command: "git push --force" }, ctx()),
    ).toMatch(/^Error: blocked by hook blockDangerous: /);
    expect(runBash).not.toHaveBeenCalled();
    expect(rt.events).toEqual([
      expect.objectContaining({
        hookId: "protectPaths",
        tool: "write",
        phase: "pre",
        outcome: "blocked",
      }),
      expect.objectContaining({
        hookId: "blockDangerous",
        tool: "bash",
        phase: "pre",
        outcome: "blocked",
      }),
    ]);
    // Harmless calls go through.
    expect(await wrapWithHooks(bash, () => rt).execute({ command: "ls" }, ctx())).toBe("ok");
  });

  it("a custom pre hook blocks on exit 2 with its output as the reason", async () => {
    const config = defaultHooksConfig();
    config.custom = [{ id: "guard", event: "preToolUse", tool: "bash", command: "guard {tool}" }];
    const rt = runtime(config, { guard: { exitCode: 2, tail: "line1\nno deploys on Friday" } });
    const { tool, execute } = fakeTool("bash");
    const result = await wrapWithHooks(tool, () => rt).execute({ command: "deploy" }, ctx());
    expect(result).toBe("Error: blocked by hook guard: line1\nno deploys on Friday");
    expect(execute).not.toHaveBeenCalled();
    expect(rt.runCommand).toHaveBeenCalledWith("guard bash", 60_000, expect.any(AbortSignal));
    expect(rt.events[0]).toMatchObject({ hookId: "guard", phase: "pre", outcome: "blocked" });
    // Exit 1 is a failed hook, not a block: the tool still runs.
    const rt2 = runtime(config, { guard: { exitCode: 1, tail: "meh" } });
    expect(await wrapWithHooks(tool, () => rt2).execute({ command: "deploy" }, ctx())).toBe("ok");
    expect(rt2.events[0]).toMatchObject({ hookId: "guard", outcome: "failed", detail: "meh" });
  });

  it("runs format then lint after an edit and appends only failing output", async () => {
    const config = defaultHooksConfig();
    config.presets.formatOnEdit = { enabled: true, command: "fmt {file}" };
    config.presets.lintOnEdit = { enabled: true, command: "lint {file}" };
    const long = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join("\n");
    const rt = runtime(config, { lint: { exitCode: 1, tail: long } });
    const { tool, execute } = fakeTool("edit", "Edited a.ts");
    const result = await wrapWithHooks(tool, () => rt).execute(
      { file_path: "a.ts", edits: [] },
      ctx(),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rt.runCommand.mock.calls.map((c) => c[0])).toEqual(['fmt "a.ts"', 'lint "a.ts"']);
    expect(result).toBe(`Edited a.ts\n\n[lint] exit 1\n${lastLines(long)}`);
    expect(result).not.toContain("l10\n");
    expect(result).toContain("l11\n");
    expect(rt.events.map((e) => [e.hookId, e.outcome])).toEqual([
      ["formatOnEdit", "ran"],
      ["lintOnEdit", "failed"],
    ]);
  });

  it("skips post hooks when the tool itself failed, and survives a throwing runner", async () => {
    const config = defaultHooksConfig();
    config.presets.formatOnEdit = { enabled: true, command: "fmt" };
    const rt = runtime(config);
    const { tool } = fakeTool("write", "Error: no such dir");
    expect(await wrapWithHooks(tool, () => rt).execute({ file_path: "a.ts" }, ctx())).toBe(
      "Error: no such dir",
    );
    expect(rt.runCommand).not.toHaveBeenCalled();

    const throwing = runtime(config);
    throwing.runCommand.mockRejectedValue(new Error("spawn failed"));
    const { tool: ok } = fakeTool("write", "ok");
    expect(await wrapWithHooks(ok, () => throwing).execute({ file_path: "a.ts" }, ctx())).toBe(
      "ok",
    );
    expect(throwing.events[0]).toMatchObject({
      outcome: "failed",
      detail: "could not run: spawn failed",
    });
  });

  it("appends to structured results too", () => {
    expect(appendToResult("a", "\n\nb")).toBe("a\n\nb");
    expect(appendToResult({ content: "a" }, "\n\nb")).toEqual({ content: "a\n\nb" });
    expect(appendToResult({ content: [{ type: "text", text: "a" }] }, "\n\nb")).toEqual({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    });
  });
});
