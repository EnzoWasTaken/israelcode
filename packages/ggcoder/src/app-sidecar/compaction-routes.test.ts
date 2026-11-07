import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import type { CompactionInfo, CompactionSessionLike } from "./compaction.js";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir so the
// route's gg-app.json writes never touch the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { handleCompactionRoutes } = await import("./compaction-routes.js");
const { createCompactionController } = await import("./compaction.js");
const { loadCompactionPref } = await import("./app-settings.js");

interface Reply {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: http.ServerResponse; reply: Promise<Reply> } {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  return { res: res as unknown as http.ServerResponse, reply };
}

function fakeSession(opts: { compacted?: boolean; lastCompactionAt?: number } = {}) {
  const handlers = new Set<
    (d: { compacted: boolean; originalCount: number; newCount: number }) => void
  >();
  const info: CompactionInfo = {
    threshold: 0.85,
    atTokens: 400_000,
    contextWindow: 200_000,
    activeTokens: 50_000,
    lastCompactionRewindId: opts.lastCompactionAt ? "cp-3" : null,
    ...(opts.lastCompactionAt ? { lastCompactionAt: opts.lastCompactionAt } : {}),
  };
  const session = {
    info,
    setCompactionOverride: vi.fn((o: { threshold?: number; atTokens?: number | null }) => {
      info.threshold = o.threshold ?? 0.85;
      info.atTokens = o.atTokens === null ? null : (o.atTokens ?? 400_000);
    }),
    getCompactionInfo: () => ({ ...info }),
    eventBus: {
      on: (_e: "compaction_end", h: typeof handlers extends Set<infer T> ? T : never) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    },
    compact: vi.fn(async (_c: undefined, _m?: string, _focus?: string) => {
      const compacted = opts.compacted ?? true;
      if (compacted) {
        info.lastCompactionAt = Date.now();
        info.lastCompactionRewindId = "cp-9";
      }
      for (const h of handlers) h({ compacted, originalCount: 40, newCount: compacted ? 3 : 40 });
    }),
    undoLastCompaction: vi.fn(async () => {
      delete info.lastCompactionAt;
      info.lastCompactionRewindId = null;
      return { restoredCount: 40, newCount: 3 };
    }),
  };
  return session as typeof session & CompactionSessionLike;
}

function makeCtx(session = fakeSession(), overrides: Partial<Record<string, unknown>> = {}) {
  const broadcast = vi.fn();
  const controller = createCompactionController({ session, pref: { pins: [] }, broadcast });
  const runAgent = vi.fn(async (_label: string, run: () => Promise<void>) => {
    await run();
  });
  return {
    ctx: {
      mode: "code",
      goal: null,
      cwd: path.join(home, "proj"),
      compaction: controller,
      broadcast,
      running: false,
      runClaim: { active: false },
      runAgent,
      clearPendingPlan: vi.fn(),
      ...overrides,
    },
    controller,
    broadcast,
    runAgent,
    session,
  };
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleCompactionRoutes(
      ctx as unknown as SessionRouteContext,
      req as unknown as http.IncomingMessage,
      res,
      url,
      method,
    ),
  ).toBe(true);
  return reply;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-compaction-routes-"));
  await fs.mkdir(path.join(home, "proj"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("GET /compaction", () => {
  it("returns the pref and the session's info", async () => {
    const { ctx } = makeCtx();
    const reply = await call(ctx, "/compaction", undefined, "GET");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      pref: { pins: [] },
      info: expect.objectContaining({ threshold: 0.85, contextWindow: 200_000 }),
    });
  });

  it("is refused outside coding sessions", async () => {
    const { ctx } = makeCtx(fakeSession(), { mode: "chat" });
    expect((await call(ctx, "/compaction", undefined, "GET")).status).toBe(404);
  });
});

describe("POST /compaction", () => {
  it("saves per project, applies to the session and broadcasts", async () => {
    const { ctx, broadcast, session } = makeCtx();
    const reply = await call(ctx, "/compaction", {
      threshold: 0.6,
      atTokens: null,
      pins: [" API lives in src/api.ts ", ""],
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      pref: { threshold: 0.6, atTokens: null, pins: ["API lives in src/api.ts"] },
      info: expect.objectContaining({ threshold: 0.6, atTokens: null }),
    });
    expect(session.setCompactionOverride).toHaveBeenLastCalledWith({
      threshold: 0.6,
      atTokens: null,
    });
    expect(broadcast).toHaveBeenCalledWith(
      "compaction_state",
      expect.objectContaining({ pref: expect.anything() }),
    );
    expect(await loadCompactionPref(path.join(home, "proj"))).toEqual({
      threshold: 0.6,
      atTokens: null,
      pins: ["API lives in src/api.ts"],
    });
    // A later partial change keeps the rest.
    await call(ctx, "/compaction", { threshold: null });
    expect(await loadCompactionPref(path.join(home, "proj"))).toEqual({
      atTokens: null,
      pins: ["API lives in src/api.ts"],
    });
  });

  it("rejects an out-of-range threshold or a non-string pin", async () => {
    const { ctx } = makeCtx();
    expect((await call(ctx, "/compaction", { threshold: 0.1 })).status).toBe(400);
    expect((await call(ctx, "/compaction", { pins: [1] })).status).toBe(400);
    expect((await call(ctx, "/compaction", { atTokens: 5 })).status).toBe(400);
  });
});

describe("POST /compaction/compact", () => {
  it("compacts inside the run lifecycle with the focus and reports the counts", async () => {
    const { ctx, runAgent, session } = makeCtx();
    const reply = await call(ctx, "/compaction/compact", { focus: "the migration" });
    expect(reply).toEqual({
      status: 200,
      body: { compacted: true, originalCount: 40, newCount: 3 },
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(session.compact).toHaveBeenCalledWith(undefined, "manual", "the migration");
  });

  it("refuses while a run is active", async () => {
    const { ctx, session } = makeCtx(fakeSession(), { running: true });
    expect((await call(ctx, "/compaction/compact", {})).status).toBe(409);
    expect(session.compact).not.toHaveBeenCalled();
  });
});

describe("POST /compaction/undo", () => {
  it("restores the last compaction and 404s when there is none", async () => {
    const { ctx, session, broadcast } = makeCtx(fakeSession({ lastCompactionAt: 123 }));
    const reply = await call(ctx, "/compaction/undo");
    expect(reply).toEqual({ status: 200, body: { restoredCount: 40, newCount: 3 } });
    expect(session.undoLastCompaction).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith("compaction_state", expect.anything());
    expect((await call(ctx, "/compaction/undo")).status).toBe(404);
  });
});
