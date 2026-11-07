import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { APP_DIR_NAME } from "@kenkaiiii/gg-core";
import {
  COMPACTION_THRESHOLD_PRESETS,
  buildCompactionFocus,
  compactionRewindPrompt,
  normalizeCompactionPref,
} from "./compaction-control.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());
const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, shouldCompact: shouldCompactMock, compact: compactMock };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

describe("normalizeCompactionPref", () => {
  it("clamps the threshold, floors the token count and trims the pins", () => {
    expect(
      normalizeCompactionPref({
        threshold: 0.7,
        atTokens: 150_000.7,
        pins: ["  keep  the API  ", "", "keep the API", 7, "x".repeat(300)],
      }),
    ).toEqual({ threshold: 0.7, atTokens: 150_000, pins: ["keep the API", "x".repeat(200)] });
    expect(normalizeCompactionPref({ threshold: 0.2, atTokens: 10, pins: [] })).toBeNull();
    expect(normalizeCompactionPref({ atTokens: null, pins: [] })).toEqual({
      atTokens: null,
      pins: [],
    });
    expect(normalizeCompactionPref("nope")).toBeNull();
    const many = normalizeCompactionPref({ pins: Array.from({ length: 30 }, (_, i) => `f${i}`) });
    expect(many?.pins).toHaveLength(20);
    expect(COMPACTION_THRESHOLD_PRESETS).toEqual([0.6, 0.7, 0.85]);
  });
});

describe("buildCompactionFocus", () => {
  it("lists the pins first, then the user's focus; undefined with neither", () => {
    expect(buildCompactionFocus(["a", "b"], "  the migration plan ")).toBe(
      "Keep these facts verbatim:\n- a\n- b\n\nthe migration plan",
    );
    expect(buildCompactionFocus(["a"])).toBe("Keep these facts verbatim:\n- a");
    expect(buildCompactionFocus([], "only this")).toBe("only this");
    expect(buildCompactionFocus([], "   ")).toBeUndefined();
    expect(compactionRewindPrompt(12)).toBe("Before compaction (12 messages)");
    expect(compactionRewindPrompt(1)).toBe("Before compaction (1 message)");
  });
});

describe("AgentSession compaction control", () => {
  let restoreHome: (() => void) | undefined;
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-control-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-control-project-"));
    restoreHome = useFakeHome(tmpHome);
    shouldCompactMock.mockReset();
    compactMock.mockReset();
    agentLoopMock.mockReset();
    await fs.mkdir(path.join(tmpHome, APP_DIR_NAME), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, APP_DIR_NAME, "auth.json"),
      JSON.stringify({
        anthropic: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    await fs.writeFile(
      path.join(tmpHome, APP_DIR_NAME, "settings.json"),
      JSON.stringify({ autoCompact: true, compactThreshold: 0.85 }),
    );
  });

  afterEach(async () => {
    restoreHome?.();
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("opens a rewind point before compaction, merges the pins into focus and undoes", async () => {
    shouldCompactMock.mockReturnValue(false);
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "done" });
      yield { type: "agent_done" };
    });
    compactMock.mockImplementation(async (messages: Message[]) => ({
      messages: [messages[0]!, { role: "user", content: "[session compacted] summary" }],
      result: {
        compacted: true,
        originalCount: messages.length,
        newCount: 2,
        tokensBeforeEstimate: 100_000,
        tokensAfterEstimate: 500,
      },
    }));

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      checkpoints: true,
      getPinnedFacts: () => ["the API lives in src/api.ts"],
    });
    await session.initialize();
    session.setCompactionOverride({ threshold: 0.6, atTokens: null });
    expect(session.getCompactionInfo()).toMatchObject({
      threshold: 0.6,
      atTokens: null,
      lastCompactionRewindId: null,
    });
    await session.prompt("first");
    await session.prompt("second");
    const beforeCount = (session as unknown as { messages: Message[] }).messages.length;
    const pathBefore = session.getState().sessionPath;

    const openedPoints: string[] = [];
    session.eventBus.on("compaction_start", () => {
      void session.listRewindPoints().then((points) => {
        openedPoints.push(...points.map((p) => p.prompt ?? ""));
      });
    });
    await session.compact(undefined, "manual", "the migration plan");

    expect(compactMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        focus: "Keep these facts verbatim:\n- the API lives in src/api.ts\n\nthe migration plan",
      }),
    );
    // The last point opened in the pre-compaction store is the compaction one.
    await vi.waitFor(() => expect(openedPoints.length).toBeGreaterThan(0));
    expect(openedPoints.at(-1)).toMatch(/^Before compaction \(\d+ messages\)$/);
    const info = session.getCompactionInfo();
    expect(info.lastCompactionRewindId).toMatch(/^cp-\d+$/);
    expect(info.lastCompactionAt).toEqual(expect.any(Number));
    const internals = session as unknown as { messages: Message[] };
    expect(internals.messages).toHaveLength(2);

    const undone = await session.undoLastCompaction();
    expect(undone).toEqual({ restoredCount: beforeCount, newCount: 2 });
    expect(internals.messages.map((m) => m.content)).toContain("first");
    expect(internals.messages.map((m) => m.content)).toContain("second");
    expect(session.getCompactionInfo().lastCompactionRewindId).toBeNull();
    // Restored history lives in a new checkpoint file, so it is what resumes.
    expect(session.getState().sessionPath).not.toBe(pathBefore);
    const rows = (await fs.readFile(session.getState().sessionPath!, "utf-8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type?: string; message?: Message });
    const texts = rows.filter((r) => r.type === "message").map((r) => r.message?.content);
    expect(texts).toContain("first");
    expect(texts).not.toContain("[session compacted] summary");
    await expect(session.undoLastCompaction()).rejects.toThrow(/nothing|no compaction/i);
    await session.dispose();
  }, 20_000);
});
