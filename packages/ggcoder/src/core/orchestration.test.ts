import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  buildOrchestrateMessage,
  hasOrchestrateKeyword,
  lastOrchestrateState,
  orchestrateNoticeState,
} from "./orchestration.js";
import { buildUltracodeMessage, ULTRACODE_ACTIVE_LIMIT } from "./ultracode.js";

describe("orchestration", () => {
  it("spots the keyword as a word, in any case", () => {
    expect(hasOrchestrateKeyword("orchestrate: rewrite the parser")).toBe(true);
    expect(hasOrchestrateKeyword("Please ORCHESTRATE this")).toBe(true);
    expect(hasOrchestrateKeyword("orchestrate-mode.ts")).toBe(false);
    expect(hasOrchestrateKeyword("orchestrated")).toBe(false);
  });

  it("asks for plan, delegate, review and a reviewed summary, naming the worker model", () => {
    const text = buildOrchestrateMessage(true, ["spawn_agent", "todo_write"], "GPT-5 mini")
      .content as string;
    expect(text).toContain("`todo_write`");
    expect(text).toContain("`spawn_agent`");
    expect(text).toContain(`up to ${ULTRACODE_ACTIVE_LIMIT} running at once`);
    expect(text).toContain("the Worker model (GPT-5 mini)");
    expect(text).toContain("The children do the pieces, not you.");
    expect(text).toMatch(/Review every worker's result before you reply/);
    expect(text).toContain("run the project's checks yourself");
    expect(text).toContain("fix round");
    expect(text).toContain("one reviewed summary");
    expect(text).toContain("Small or single-step requests stay direct");
  });

  it("names only the tools the session has and falls back to the orchestrator's model", () => {
    const solo = buildOrchestrateMessage(true, ["read"]).content as string;
    expect(solo).not.toContain("`todo_write`");
    expect(solo).toContain("no `spawn_agent`");
    const unpinned = buildOrchestrateMessage(true, ["spawn_agent"]).content as string;
    expect(unpinned).toContain("the same model as you");
  });

  it("asks for worktree isolation and a merge review when worktree workers are on", () => {
    const text = buildOrchestrateMessage(true, ["spawn_agent"], undefined, true).content as string;
    expect(text).toContain("set isolation 'worktree' on every task that edits files");
    expect(text).toContain("merge review");
    const plain = buildOrchestrateMessage(true, ["spawn_agent"]).content as string;
    expect(plain).not.toContain("isolation");
  });

  it("is hidden runtime provenance, like the Ultracode notice", () => {
    const notice = buildOrchestrateMessage(true, []);
    expect(notice.role).toBe("user");
    expect(notice.provenance).toEqual({
      source: "runtime",
      kind: "notification",
      visibility: "hidden",
    });
  });

  it("reads the newest notice in a history, defaulting to off", () => {
    const on = buildOrchestrateMessage(true, []);
    const off = buildOrchestrateMessage(false, []);
    const user: Message = { role: "user", content: "hi" };
    expect(lastOrchestrateState([user])).toBe(false);
    expect(lastOrchestrateState([on, user])).toBe(true);
    expect(lastOrchestrateState([on, user, off])).toBe(false);
  });

  it("does not mistake Ultracode notices or plain prompts for its own", () => {
    expect(orchestrateNoticeState(buildUltracodeMessage(true, []))).toBeNull();
    expect(orchestrateNoticeState({ role: "user", content: "Orchestrate the deploy" })).toBeNull();
    expect(orchestrateNoticeState(buildOrchestrateMessage(false, []))).toBe(false);
    expect(lastOrchestrateState([buildUltracodeMessage(true, [])])).toBe(false);
  });
});
