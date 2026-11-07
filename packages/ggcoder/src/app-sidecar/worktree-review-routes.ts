import type http from "node:http";
import { log } from "../core/logger.js";
import { WorktreeWorkerError } from "../core/worktree-workers.js";
import { saveWorktreeWorkersPref, type WorktreeWorkersPref } from "./app-settings.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";
import { WorktreeReviewError } from "./worktree-review.js";

/** `{ enabled?, autoMerge? }`, or null when a field is malformed. */
function parsePrefBody(raw: string): Partial<WorktreeWorkersPref> | null {
  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { enabled, autoMerge } = body as Record<string, unknown>;
  const out: Partial<WorktreeWorkersPref> = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return null;
    out.enabled = enabled;
  }
  if (autoMerge !== undefined) {
    if (autoMerge !== "never" && autoMerge !== "clean-and-verified") return null;
    out.autoMerge = autoMerge;
  }
  return out;
}

function parseBranchBody(raw: string): Record<string, unknown> | null {
  try {
    const body = JSON.parse(raw || "{}") as unknown;
    if (!body || typeof body !== "object") return null;
    const branch = (body as { branch?: unknown }).branch;
    return typeof branch === "string" && branch.trim() ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof WorktreeReviewError) {
    json(res, err.status, { error: err.message, ...(err.files && { files: err.files }) });
  } else if (err instanceof WorktreeWorkerError) {
    json(res, 409, { error: err.message, files: [...err.files] });
  } else {
    log("ERROR", "worktree-review", "merge review action failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Merge review routes for worktree-isolated workers in a coding window:
 * list them, read a diff, preview conflicts, run the checks in a worktree,
 * merge or discard it, and switch the feature per project. Refused for chat,
 * Motion and Goal sessions.
 */
export function handleWorktreeReviewRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  const pathname = url.split("?")[0] ?? url;
  if (pathname !== "/worktree-workers" && !pathname.startsWith("/worktree-workers/")) return false;
  if (method !== "GET" && method !== "POST") return false;
  const review = ctx.worktreeWorkers;
  if (!review || ctx.mode !== "code" || ctx.goal) {
    json(res, 404, {
      error: "Worktree workers are only available in Israel Code's coding sessions.",
    });
    return true;
  }
  const branchParam = () => new URL(url, `http://${ctx.host}`).searchParams.get("branch")?.trim();

  if (pathname === "/worktree-workers" && method === "GET") {
    review.statePayload().then(
      (payload) => json(res, 200, payload),
      (err) => fail(res, err),
    );
    return true;
  }

  if (pathname === "/worktree-workers" && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const partial = parsePrefBody(raw);
      if (!partial) {
        json(res, 400, {
          error: "Send enabled (boolean) and/or autoMerge ('never' or 'clean-and-verified').",
        });
        return;
      }
      try {
        const saved = await saveWorktreeWorkersPref(ctx.cwd, partial);
        json(res, 200, await review.setPref(saved));
      } catch (err) {
        fail(res, err);
      }
    });
    return true;
  }

  if (
    (pathname === "/worktree-workers/diff" || pathname === "/worktree-workers/preview") &&
    method === "GET"
  ) {
    const branch = branchParam();
    if (!branch) {
      json(res, 400, { error: "branch is required" });
      return true;
    }
    const action = pathname.endsWith("/diff") ? review.diff(branch) : review.preview(branch);
    action.then(
      (payload) => json(res, 200, payload),
      (err) => fail(res, err),
    );
    return true;
  }

  const actions = [
    "/worktree-workers/verify",
    "/worktree-workers/merge",
    "/worktree-workers/discard",
  ];
  if (actions.includes(pathname) && method === "POST") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const body = parseBranchBody(raw);
      if (!body) {
        json(res, 400, { error: "branch is required" });
        return;
      }
      const branch = String(body.branch).trim();
      try {
        if (pathname.endsWith("/verify")) {
          json(res, 200, await review.verify(branch));
        } else if (pathname.endsWith("/merge")) {
          const mode = body.mode ?? "squash";
          if (mode !== "squash" && mode !== "merge") {
            json(res, 400, { error: "mode must be 'squash' or 'merge'" });
            return;
          }
          json(res, 200, await review.merge(branch, mode));
        } else {
          json(res, 200, await review.discard(branch));
        }
      } catch (err) {
        fail(res, err);
      }
    });
    return true;
  }

  return false;
}
