import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBackgroundSessionRegistry,
  handleBackgroundSessionRoutes,
  INTERRUPTED_DETAIL,
  makeTitle,
  type BackgroundSessionRegistry,
} from "./background-sessions.js";
import { createAskUserBridge } from "../core/ask-user.js";
import { createApprovalBridge } from "./approvals.js";
import type { ContextStatus, SessionContext } from "./session-types.js";

interface FakeCtx extends SessionContext {
  fake: {
    state: ContextStatus["state"];
    busy: boolean;
    detached: boolean;
    disposed: boolean;
    stops: number;
    title: string;
  };
}

function fakeContext(id: string, sessionPath: string | undefined, mode = "code"): FakeCtx {
  const fake = {
    state: "idle" as ContextStatus["state"],
    busy: false,
    detached: false,
    disposed: false,
    stops: 0,
    title: "Fix the build",
  };
  const ctx = {
    id,
    mode,
    chatAgent: "general",
    cwd: "/work/app",
    sessionPath,
    session: { getState: () => ({ sessionPath }) },
    isBusy: () => fake.busy,
    status: (): ContextStatus => ({
      state: fake.state,
      detail: fake.state === "awaiting_input" ? "Waiting for your approval" : null,
      title: fake.title,
      startedAt: 1,
      updatedAt: Date.now(),
    }),
    setDetached: (v: boolean) => {
      fake.detached = v;
    },
    stop: async () => {
      fake.stops++;
      fake.busy = false;
      fake.state = "cancelled";
      return "cancelled" as const;
    },
    dispose: async () => {
      fake.disposed = true;
    },
    fake,
  };
  return ctx as unknown as FakeCtx;
}

let dir: string;
let file: string;
let registry: BackgroundSessionRegistry;
let sessionsDir: string;

function makeRegistry(graceMs = 1000): BackgroundSessionRegistry {
  return createBackgroundSessionRegistry({
    file,
    graceMs,
    disposeContext: async (ctx) => {
      await ctx.dispose();
    },
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bgs-"));
  file = path.join(dir, "background-sessions.json");
  sessionsDir = path.join(dir, "sessions");
  await fs.mkdir(sessionsDir);
  registry = makeRegistry();
  await registry.load();
});

afterEach(async () => {
  registry.close();
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const convo = (name: string) => path.join(sessionsDir, `${name}.jsonl`);

describe("detach", () => {
  it("keeps a busy session alive and its work running", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    const result = await registry.detach("a");
    expect(result).toEqual({ found: true, kept: true, status: "running" });
    expect(ctx.fake.disposed).toBe(false);
    expect(ctx.fake.stops).toBe(0);
    expect(ctx.fake.detached).toBe(true);
    expect(registry.rows()[0]).toMatchObject({ id: "a", attached: false, status: "running" });
  });

  it("disposes an idle session without leaving a row", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    const result = await registry.detach("a");
    expect(result.kept).toBe(false);
    expect(ctx.fake.disposed).toBe(true);
    expect(registry.rows()).toEqual([]);
  });

  it("keeps a session waiting on input", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.state = "awaiting_input";
    expect((await registry.detach("a")).kept).toBe(true);
  });
});

describe("reattach", () => {
  it("finds the live detached context for the same conversation and mode", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    await registry.detach("a");
    expect(registry.findDetached(convo("a"), "code", "general")).toBe(ctx);
    expect(registry.findDetached(convo("a"), "chat", "general")).toBeUndefined();
    expect(registry.findDetached(convo("b"), "code", "general")).toBeUndefined();
    registry.attach("a");
    expect(ctx.fake.detached).toBe(false);
    expect(ctx.fake.disposed).toBe(false);
    // Attached to a window now: not offered to a second one.
    expect(registry.findDetached(convo("a"), "code", "general")).toBeUndefined();
    expect(registry.rows()[0]?.attached).toBe(true);
  });

  it("matches chat contexts by agent", async () => {
    const ctx = fakeContext("a", convo("a"), "chat");
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    await registry.detach("a");
    expect(registry.findDetached(convo("a"), "chat", "general")).toBe(ctx);
    expect(registry.findDetached(convo("a"), "chat", "other")).toBeUndefined();
  });
});

describe("grace disposal", () => {
  it("disposes a finished detached session after the grace period and keeps a record", async () => {
    vi.useFakeTimers();
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    await registry.detach("a");
    ctx.fake.busy = false;
    ctx.fake.state = "completed";
    registry.refresh("a");
    await vi.advanceTimersByTimeAsync(999);
    expect(ctx.fake.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(ctx.fake.disposed).toBe(true);
    expect(registry.rows()[0]).toMatchObject({ id: null, status: "completed", attached: false });
  });

  it("does not dispose when reattached first", async () => {
    vi.useFakeTimers();
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    await registry.detach("a");
    ctx.fake.busy = false;
    ctx.fake.state = "completed";
    registry.refresh("a");
    registry.attach("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.fake.disposed).toBe(false);
  });

  it("never times out while awaiting input", async () => {
    vi.useFakeTimers();
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.state = "awaiting_input";
    await registry.detach("a");
    registry.refresh("a");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(ctx.fake.disposed).toBe(false);
  });
});

describe("pending input outlives the normal timeouts while detached", () => {
  it("an ask_user deadline re-arms instead of expiring", async () => {
    vi.useFakeTimers();
    let detached = true;
    const onTimeout = vi.fn();
    const asks = createAskUserBridge({
      broadcast: () => {},
      timeoutMs: 1000,
      isSuspended: () => detached,
      onTimeout,
    });
    const settled = vi.fn();
    void asks.park({ questions: [] } as unknown as Parameters<typeof asks.park>[0]).then(settled);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(asks.pendingCount).toBe(1);
    detached = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("an approval stays pending until answered", async () => {
    vi.useFakeTimers();
    const approvals = createApprovalBridge({
      broadcast: () => {},
      isAlwaysAllowed: async () => false,
      rememberAlways: async () => {},
    });
    void approvals.request(
      { tool: "bash", command: "rm x" } as unknown as Parameters<typeof approvals.request>[0],
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(approvals.list()).toHaveLength(1);
  });
});

describe("persistence", () => {
  it("round-trips: running becomes interrupted, content is only the short title", async () => {
    const ctx = fakeContext("a", convo("a"));
    ctx.fake.title = makeTitle("x".repeat(500));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    await registry.detach("a");
    await registry.flush();
    const raw = await fs.readFile(file, "utf8");
    const stored = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> };
    expect(stored.sessions).toHaveLength(1);
    expect(Object.keys(stored.sessions[0]!).sort()).toEqual(
      [
        "attached",
        "chatAgent",
        "cwd",
        "detail",
        "id",
        "mode",
        "sessionPath",
        "startedAt",
        "status",
        "title",
        "updatedAt",
      ].sort(),
    );
    expect((stored.sessions[0]!.title as string).length).toBeLessThanOrEqual(80);
    registry.close();

    const next = makeRegistry();
    await next.load();
    expect(next.rows()).toHaveLength(1);
    expect(next.rows()[0]).toMatchObject({
      id: null,
      status: "interrupted",
      detail: INTERRUPTED_DETAIL,
      sessionPath: convo("a"),
    });
    next.close();
  });

  it("drops finished rows older than 7 days and tolerates a corrupt file", async () => {
    const old = {
      cwd: "/x",
      mode: "code",
      title: "old",
      status: "completed",
      updatedAt: Date.now() - 8 * 24 * 60 * 60_000,
    };
    await fs.writeFile(file, JSON.stringify({ sessions: [old] }));
    const a = makeRegistry();
    await a.load();
    expect(a.rows()).toEqual([]);
    a.close();
    await fs.writeFile(file, "{not json");
    const b = makeRegistry();
    await b.load();
    expect(b.rows()).toEqual([]);
    b.close();
  });
});

describe("makeTitle", () => {
  it("flattens whitespace and truncates", () => {
    expect(makeTitle("  a\n\n b ")).toBe("a b");
    expect(makeTitle("y".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

// ── routes ───────────────────────────────────────────────────

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const handled = new Promise<void>((resolve) => {
    const taken = handleBackgroundSessionRoutes(
      {
        registry,
        sessionsDir,
        readBody: async () => (body === undefined ? "" : JSON.stringify(body)),
        json: (_res, s, b) => {
          status = s;
          payload = b as Record<string, unknown>;
          resolve();
        },
      },
      {} as never,
      {} as never,
      url,
      method,
    );
    if (!taken) resolve();
  });
  await handled;
  return { status, body: payload };
}

describe("routes", () => {
  it("lists rows including attached sessions", async () => {
    registry.track(fakeContext("a", convo("a")));
    const res = await call("GET", "/background-sessions");
    expect((res.body.sessions as unknown[]).length).toBe(1);
    expect(res.body.sessions).toMatchObject([{ id: "a", attached: true }]);
  });

  it("stop cancels through the context", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    ctx.fake.busy = true;
    ctx.fake.state = "running";
    const res = await call("POST", "/background-sessions/stop", { id: "a" });
    expect(res).toEqual({ status: 200, body: { ok: true, status: "cancelled" } });
    expect(ctx.fake.stops).toBe(1);
  });

  it("validates bodies", async () => {
    expect((await call("POST", "/background-sessions/stop", {})).status).toBe(400);
    expect((await call("POST", "/background-sessions/dismiss", { id: 5 })).status).toBe(400);
    expect((await call("POST", "/background-sessions/delete", { id: "nope" })).status).toBe(404);
  });

  it("dismiss refuses a running session and removes a finished one", async () => {
    const ctx = fakeContext("a", convo("a"));
    registry.track(ctx);
    await registry.detach("a").catch(() => {});
    const b = fakeContext("b", convo("b"));
    registry.track(b);
    b.fake.busy = true;
    b.fake.state = "running";
    await registry.detach("b");
    expect((await call("POST", "/background-sessions/dismiss", { id: "b" })).status).toBe(409);
    b.fake.busy = false;
    b.fake.state = "completed";
    expect((await call("POST", "/background-sessions/dismiss", { id: "b" })).status).toBe(200);
    expect(b.fake.disposed).toBe(true);
    expect(registry.rows()).toEqual([]);
  });

  it("delete removes the conversation file but refuses paths outside the sessions folder", async () => {
    const inside = convo("c");
    await fs.writeFile(inside, "{}\n");
    const c = fakeContext("c", inside);
    registry.track(c);
    c.fake.busy = true;
    c.fake.state = "running";
    await registry.detach("c");
    expect((await call("POST", "/background-sessions/delete", { id: "c" })).status).toBe(200);
    expect(c.fake.stops).toBe(1);
    expect(c.fake.disposed).toBe(true);
    await expect(fs.access(inside)).rejects.toThrow();

    const outside = path.join(dir, "precious.jsonl");
    await fs.writeFile(outside, "keep");
    const d = fakeContext("d", outside);
    registry.track(d);
    const res = await call("POST", "/background-sessions/delete", { id: "d" });
    expect(res.status).toBe(400);
    expect(d.fake.stops).toBe(0);
    await expect(fs.access(outside)).resolves.toBeUndefined();
  });

  it("delete refuses a session still open in a window", async () => {
    const file = convo("e");
    await fs.writeFile(file, "{}\n");
    const e = fakeContext("e", file);
    registry.track(e);
    const res = await call("POST", "/background-sessions/delete", { id: "e" });
    expect(res.status).toBe(409);
    expect(e.fake.disposed).toBe(false);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });
});
