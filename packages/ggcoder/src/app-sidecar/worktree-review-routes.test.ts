import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import type { SubAgentSnapshot } from "../core/subagent-manager.js";

// os.homedir() reads USERPROFILE on Windows; keep gg-app.json writes in a temp dir.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const core = vi.hoisted(() => ({
  worktreeStatus: vi.fn(async () => ({ dirty: 1, ahead: 2, changedFiles: 3 })),
  worktreeDiff: vi.fn(async () => ({ files: [], patch: "diff", truncated: false })),
  previewMerge: vi.fn(async () => ({ conflicts: ["a.ts"] })),
  mergeWorker: vi.fn(async () => ({ merged: true, commit: "abc" })),
  discardWorker: vi.fn(async () => {}),
  pruneEmptyWorktrees: vi.fn(async () => []),
}));
vi.mock("../core/worktree-workers.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../core/worktree-workers.js")>();
  return { ...actual, ...core };
});
vi.mock("../core/verify-loop.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../core/verify-loop.js")>();
  return {
    ...actual,
    loadVerifyConfig: async () => ({
      commands: [
        { label: "lint", command: "lint" },
        { label: "test", command: "test" },
      ],
      maxRounds: 1,
      source: "file",
    }),
  };
});

const { handleWorktreeReviewRoutes } = await import("./worktree-review-routes.js");
const { createWorktreeReviewController } = await import("./worktree-review.js");
const { WorktreeWorkerError } = await import("../core/worktree-workers.js");
const { loadWorktreeWorkersPref } = await import("./app-settings.js");

interface Reply {
  status: number;
  body: unknown;
}

function call(ctx: object, url: string, body?: unknown, method = "POST"): Promise<Reply> {
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
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  expect(
    handleWorktreeReviewRoutes(
      ctx as unknown as SessionRouteContext,
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      url,
      method,
    ),
  ).toBe(true);
  return reply;
}

let worktreePath = "";

function makeCtx(
  state: SubAgentSnapshot["state"] = "completed",
  pref: { enabled: boolean; autoMerge: "never" | "clean-and-verified" } = {
    enabled: true,
    autoMerge: "never",
  },
) {
  const broadcast = vi.fn();
  const worker = {
    agent_id: "a1",
    task_name: "edit",
    state,
    worktree: { path: worktreePath, branch: "gg/worker/edit-1", base: "main" },
  } as SubAgentSnapshot;
  const run = vi.fn(async ({ command }: { command: string }) => ({
    exitCode: command === "test" ? 1 : 0,
    durationMs: 1,
    tail: `${command} out`,
    cancelled: false,
    timedOut: false,
  }));
  const review = createWorktreeReviewController({
    cwd: path.join(home, "proj"),
    repoRoot: path.join(home, "proj"),
    managedRoot: path.join(home, "trees"),
    pref,
    listSubAgents: () => [worker],
    broadcast,
    runCommand: run as never,
  });
  return {
    ctx: {
      mode: "code",
      goal: null,
      host: "127.0.0.1",
      cwd: path.join(home, "proj"),
      worktreeWorkers: review,
      broadcast,
    },
    broadcast,
    run,
    review,
    worker,
  };
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-worktree-review-"));
  worktreePath = path.join(home, "trees", "w");
  await fs.mkdir(worktreePath, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("worktree review routes", () => {
  it("lists isolated workers with their status and pref", async () => {
    const { ctx } = makeCtx();
    const reply = await call(ctx, "/worktree-workers", undefined, "GET");
    expect(reply).toEqual({
      status: 200,
      body: {
        pref: { enabled: true, autoMerge: "never" },
        workers: [
          {
            agentId: "a1",
            name: "edit",
            branch: "gg/worker/edit-1",
            path: worktreePath,
            base: "main",
            status: { dirty: 1, ahead: 2, changedFiles: 3 },
            childState: "completed",
          },
        ],
      },
    });
  });

  it("saves the pref and broadcasts the state; rejects a bad body", async () => {
    const { ctx, broadcast } = makeCtx();
    const reply = await call(ctx, "/worktree-workers", { autoMerge: "clean-and-verified" });
    expect(reply.status).toBe(200);
    expect((reply.body as { pref: unknown }).pref).toEqual({
      enabled: true,
      autoMerge: "clean-and-verified",
    });
    expect(await loadWorktreeWorkersPref(ctx.cwd)).toEqual({
      enabled: true,
      autoMerge: "clean-and-verified",
    });
    expect(broadcast).toHaveBeenCalledWith("worktree_workers_state", reply.body);
    expect((await call(ctx, "/worktree-workers", { enabled: "yes" })).status).toBe(400);
  });

  it("returns the diff and the conflict preview; 404 for an unknown branch", async () => {
    const { ctx } = makeCtx();
    const branch = encodeURIComponent("gg/worker/edit-1");
    expect(await call(ctx, `/worktree-workers/diff?branch=${branch}`, undefined, "GET")).toEqual({
      status: 200,
      body: { files: [], patch: "diff", truncated: false },
    });
    expect(await call(ctx, `/worktree-workers/preview?branch=${branch}`, undefined, "GET")).toEqual(
      { status: 200, body: { conflicts: ["a.ts"] } },
    );
    expect((await call(ctx, "/worktree-workers/diff?branch=nope", undefined, "GET")).status).toBe(
      404,
    );
  });

  it("runs the checks in the worktree and reports progress", async () => {
    const { ctx, broadcast, run } = makeCtx();
    const reply = await call(ctx, "/worktree-workers/verify", { branch: "gg/worker/edit-1" });
    expect(reply.status).toBe(200);
    expect((reply.body as { passed: boolean }).passed).toBe(false);
    expect(run).toHaveBeenCalledWith({ cwd: worktreePath, command: "lint" });
    expect(broadcast).toHaveBeenCalledWith("worktree_verify_progress", {
      branch: "gg/worker/edit-1",
      label: "test",
      status: "failed",
      exitCode: 1,
      tail: "test out",
    });
  });

  it("merges, removes the worktree and prunes; 409 with files when refused", async () => {
    const { ctx, broadcast } = makeCtx();
    const reply = await call(ctx, "/worktree-workers/merge", {
      branch: "gg/worker/edit-1",
      mode: "squash",
    });
    expect(reply).toEqual({ status: 200, body: { merged: true, commit: "abc" } });
    expect(core.discardWorker).toHaveBeenCalled();
    expect(core.pruneEmptyWorktrees).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("worktree_workers_state", expect.anything());
    core.mergeWorker.mockRejectedValueOnce(new WorktreeWorkerError("dirty", ["x.ts"]));
    expect(
      await call(ctx, "/worktree-workers/merge", { branch: "gg/worker/edit-1", mode: "merge" }),
    ).toEqual({ status: 409, body: { error: "dirty", files: ["x.ts"] } });
  });

  it("discards an idle worker but refuses a running one", async () => {
    expect(
      await call(makeCtx().ctx, "/worktree-workers/discard", { branch: "gg/worker/edit-1" }),
    ).toEqual({ status: 200, body: { discarded: true } });
    expect(
      (
        await call(makeCtx("running").ctx, "/worktree-workers/discard", {
          branch: "gg/worker/edit-1",
        })
      ).status,
    ).toBe(409);
  });

  it("auto-merges a clean, passing worker and leaves a failing one with a reason", async () => {
    const auto = { enabled: true, autoMerge: "clean-and-verified" as const };
    const failing = makeCtx("completed", auto);
    failing.review.noteSubAgentState({ ...failing.worker, turn_count: 1 });
    await failing.review.waitForAutoMerge();
    expect(core.mergeWorker).not.toHaveBeenCalled();
    const state = await failing.review.statePayload();
    expect(state.workers[0]?.autoMerge).toEqual({
      attempted: true,
      merged: false,
      reason: "Conflicts in a.ts",
    });

    core.previewMerge.mockResolvedValueOnce({ conflicts: [] });
    const passing = makeCtx("completed", auto);
    passing.run.mockImplementation(async () => ({
      exitCode: 0,
      durationMs: 1,
      tail: "",
      cancelled: false,
      timedOut: false,
    }));
    passing.review.noteSubAgentState({ ...passing.worker, turn_count: 1 });
    await passing.review.waitForAutoMerge();
    expect(core.mergeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "gg/worker/edit-1", mode: "squash" }),
    );
    expect(passing.broadcast).toHaveBeenCalledWith("worktree_workers_state", expect.anything());
  });

  it("is refused outside coding sessions", async () => {
    const { ctx } = makeCtx();
    expect(
      (await call({ ...ctx, mode: "chat" }, "/worktree-workers", undefined, "GET")).status,
    ).toBe(404);
  });
});
