import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import {
  APPROVAL_WAIT_MS,
  approvalNeeded,
  buildPermissionNotice,
  lastPermissionMode,
  permissionNoticeState,
  wrapWithApproval,
  type PermissionMode,
} from "./permission-mode.js";

const cwd = process.cwd();
const calls = {
  write: { file_path: "src/a.ts", content: "x" },
  edit: { file_path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] },
  "bash (read-only)": { command: "git status" },
  "bash (changes state)": { command: "rm -rf dist" },
  read: { file_path: "src/a.ts" },
};

describe("permission gate matrix", () => {
  const expected: Record<PermissionMode, Record<keyof typeof calls, boolean>> = {
    bypass: {
      write: false,
      edit: false,
      "bash (read-only)": false,
      "bash (changes state)": false,
      read: false,
    },
    ask: {
      write: true,
      edit: true,
      "bash (read-only)": false,
      "bash (changes state)": true,
      read: false,
    },
    "accept-edits": {
      write: false,
      edit: false,
      "bash (read-only)": false,
      "bash (changes state)": true,
      read: false,
    },
  };
  for (const [mode, row] of Object.entries(expected) as Array<
    [PermissionMode, Record<keyof typeof calls, boolean>]
  >) {
    for (const [label, asks] of Object.entries(row) as Array<[keyof typeof calls, boolean]>) {
      it(`${mode} × ${label} → ${asks ? "asks" : "runs"}`, () => {
        const tool = label.split(" ")[0]!;
        expect(approvalNeeded(mode, tool, calls[label], cwd) !== null).toBe(asks);
      });
    }
  }

  it("shows what would change", () => {
    expect(approvalNeeded("ask", "edit", calls.edit, cwd)).toMatchObject({
      tool: "edit",
      paths: ["src/a.ts"],
      preview: expect.stringContaining("- a\n+ b"),
    });
    expect(approvalNeeded("ask", "bash", calls["bash (changes state)"], cwd)).toMatchObject({
      command: "rm -rf dist",
    });
  });
});

describe("wrapWithApproval", () => {
  const inner = (): AgentTool => ({
    name: "bash",
    description: "run",
    parameters: z.object({ command: z.string() }),
    execute: vi.fn(async () => "ran"),
  });

  it("runs approved and unneeded calls, refuses denied ones with the note", async () => {
    const tool = inner();
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ decision: "allow" })
      .mockResolvedValueOnce({ decision: "deny", note: "use the dev server" });
    const wrapped = wrapWithApproval(tool, authorize);
    const ctx = { signal: new AbortController().signal, toolCallId: "t" };
    expect(await wrapped.execute({ command: "ls" }, ctx)).toBe("ran");
    expect(await wrapped.execute({ command: "make" }, ctx)).toBe("ran");
    const denied = await wrapped.execute({ command: "make" }, ctx);
    expect(denied).toContain("declined this command");
    expect(denied).toContain("use the dev server");
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the schema and leaves room for the user to answer", () => {
    const tool = inner();
    const wrapped = wrapWithApproval(tool, vi.fn());
    expect(wrapped.parameters).toBe(tool.parameters);
    expect(wrapped.timeoutMs).toBe(300_000 + APPROVAL_WAIT_MS);
    const read: AgentTool = { ...tool, name: "read" };
    expect(wrapWithApproval(read, vi.fn())).toBe(read);
  });
});

describe("permission notices", () => {
  it("round-trips each mode and defaults to bypass", () => {
    for (const mode of ["ask", "accept-edits", "bypass"] as const) {
      expect(permissionNoticeState(buildPermissionNotice(mode))).toBe(mode);
    }
    expect(lastPermissionMode([{ role: "user", content: "hi" }])).toBe("bypass");
    expect(
      lastPermissionMode([buildPermissionNotice("ask"), { role: "user", content: "hi" }]),
    ).toBe("ask");
  });
});
