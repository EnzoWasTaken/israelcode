import type http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { environmentSecrets, redactValue } from "@kenkaiiii/gg-ai";
import { atomicWrite } from "../core/session-storage.js";
import type { SessionContext, WorkspaceMode } from "./session-types.js";

/**
 * Background sessions: a window can go away (closed, or pointed at another
 * project / conversation) while its session keeps working in the shared daemon.
 * The registry tracks every live context plus the records of ones that already
 * finished or were cut off, and persists a content-free summary to disk.
 */

export type BackgroundSessionStatus =
  "running" | "awaiting_input" | "completed" | "failed" | "cancelled" | "interrupted" | "idle";

export interface BackgroundSessionRow {
  id: string | null;
  sessionPath: string | null;
  cwd: string;
  mode: WorkspaceMode;
  chatAgent: string | null;
  title: string;
  status: BackgroundSessionStatus;
  detail: string | null;
  attached: boolean;
  startedAt: number | null;
  updatedAt: number;
}

export const BACKGROUND_GRACE_MS = 10 * 60_000;
export const BACKGROUND_ROW_CAP = 30;
export const BACKGROUND_FINISHED_TTL_MS = 7 * 24 * 60 * 60_000;
export const BACKGROUND_PUSH_DEBOUNCE_MS = 250;
export const INTERRUPTED_DETAIL = "Stopped when Israel Code closed";
const TITLE_MAX = 80;

/** A one-line title from a user's message, bounded to ~80 characters. */
export function makeTitle(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat;
}

const FINISHED: ReadonlySet<BackgroundSessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const ACTIVE: ReadonlySet<BackgroundSessionStatus> = new Set(["running", "awaiting_input"]);

function sameFile(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

interface Live {
  ctx: SessionContext;
  attached: boolean;
  /** Kept alive at least once after its window went away. */
  keptOnce: boolean;
  grace?: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  /** Where rows persist (`<agentDir>/background-sessions.json`). */
  file: string;
  /** Remove a context from the daemon and dispose it (stops its work). */
  disposeContext: (ctx: SessionContext) => Promise<void>;
  /** Called (debounced) with the rows whenever they change. */
  onRows?: (rows: BackgroundSessionRow[]) => void;
  graceMs?: number;
  now?: () => number;
}

function isRow(value: unknown): value is BackgroundSessionRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.cwd === "string" &&
    typeof r.title === "string" &&
    typeof r.status === "string" &&
    typeof r.updatedAt === "number" &&
    (r.mode === "code" || r.mode === "chat" || r.mode === "motion")
  );
}

export function createBackgroundSessionRegistry(options: RegistryOptions) {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? BACKGROUND_GRACE_MS;
  const live = new Map<string, Live>();
  /** Finished / interrupted rows with no live context. */
  let records: BackgroundSessionRow[] = [];
  let closed = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let writeChain: Promise<void> = Promise.resolve();
  const secrets = environmentSecrets(process.env);
  const clean = (text: string): string => redactValue(text, { secrets });

  const pathOf = (ctx: SessionContext): string | null =>
    ctx.session.getState().sessionPath ?? ctx.sessionPath ?? null;

  const liveRow = (entry: Live): BackgroundSessionRow => {
    const s = entry.ctx.status();
    return {
      id: entry.ctx.id,
      sessionPath: pathOf(entry.ctx),
      cwd: entry.ctx.cwd,
      mode: entry.ctx.mode,
      chatAgent: entry.ctx.mode === "chat" ? entry.ctx.chatAgent : null,
      title: clean(s.title),
      status: s.state,
      detail: s.detail === null ? null : clean(s.detail),
      attached: entry.attached,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
    };
  };

  const rows = (): BackgroundSessionRow[] => {
    const liveRows = [...live.values()].map(liveRow);
    const livePaths = liveRows.flatMap((r) => (r.sessionPath ? [r.sessionPath] : []));
    const dead = records.filter(
      (r) => !r.sessionPath || !livePaths.some((p) => sameFile(p, r.sessionPath!)),
    );
    return [...liveRows, ...dead].sort((a, b) => b.updatedAt - a.updatedAt);
  };

  /** Rows worth remembering: background runs and anything still working. */
  const persistable = (): BackgroundSessionRow[] => {
    const keep = new Set(
      [...live.values()]
        .filter((e) => e.keptOnce || ACTIVE.has(e.ctx.status().state))
        .map((e) => e.ctx.id),
    );
    return rows()
      .filter((r) => (r.id === null ? true : keep.has(r.id)))
      .slice(0, BACKGROUND_ROW_CAP);
  };

  const writeNow = (): Promise<void> => {
    const body = JSON.stringify({ version: 1, sessions: persistable() }, null, 2);
    writeChain = writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(options.file), { recursive: true });
        await atomicWrite(options.file, body);
      })
      .catch(() => {});
    return writeChain;
  };

  const changed = (): void => {
    if (closed || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      if (closed) return;
      void writeNow();
      options.onRows?.(rows());
    }, BACKGROUND_PUSH_DEBOUNCE_MS);
    pushTimer.unref?.();
  };

  const remember = (row: BackgroundSessionRow): void => {
    const key = row.sessionPath;
    records = [
      { ...row, id: null, attached: false },
      ...records.filter((r) => !key || !r.sessionPath || !sameFile(r.sessionPath, key)),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, BACKGROUND_ROW_CAP);
  };

  const clearGrace = (entry: Live): void => {
    if (entry.grace) clearTimeout(entry.grace);
    entry.grace = undefined;
  };

  /** Finish a detached context for good, leaving its final row behind. */
  const retire = async (entry: Live, keepRecord: boolean): Promise<void> => {
    clearGrace(entry);
    const row = liveRow(entry);
    live.delete(entry.ctx.id);
    if (keepRecord && entry.keptOnce && row.status !== "idle") {
      remember({ ...row, status: ACTIVE.has(row.status) ? "cancelled" : row.status });
    }
    await options.disposeContext(entry.ctx).catch(() => {});
    changed();
  };

  const armGrace = (entry: Live): void => {
    if (entry.attached || entry.grace || closed) return;
    entry.grace = setTimeout(() => {
      entry.grace = undefined;
      if (live.get(entry.ctx.id) !== entry || entry.attached) return;
      if (entry.ctx.isBusy() || ACTIVE.has(entry.ctx.status().state)) return;
      void retire(entry, true);
    }, graceMs);
    entry.grace.unref?.();
  };

  const find = (target: { id?: string; sessionPath?: string }): Live | undefined => {
    if (target.id) return live.get(target.id);
    if (target.sessionPath) {
      for (const entry of live.values()) {
        const p = pathOf(entry.ctx);
        if (p && sameFile(p, target.sessionPath)) return entry;
      }
    }
    return undefined;
  };

  const findRecordIndex = (target: { id?: string; sessionPath?: string }): number =>
    records.findIndex(
      (r) =>
        (target.sessionPath && r.sessionPath && sameFile(r.sessionPath, target.sessionPath)) ||
        false,
    );

  return {
    rows,

    /** A new context exists, attached to its window. */
    track(ctx: SessionContext): void {
      live.set(ctx.id, { ctx, attached: true, keptOnce: false });
      changed();
    },

    /** The context's run state, approvals, asks or plan changed. */
    refresh(id: string): void {
      const entry = live.get(id);
      if (!entry) return;
      if (!entry.attached) {
        if (ACTIVE.has(entry.ctx.status().state) || entry.ctx.isBusy()) clearGrace(entry);
        else armGrace(entry);
      }
      changed();
    },

    /** Forget a context removed by DELETE /session/:id (the caller disposes it). */
    untrack(id: string): void {
      const entry = live.get(id);
      if (!entry) return;
      clearGrace(entry);
      const row = liveRow(entry);
      live.delete(id);
      if (entry.keptOnce && row.status !== "idle") {
        remember({ ...row, status: ACTIVE.has(row.status) ? "cancelled" : row.status });
      }
      changed();
    },

    /**
     * The window is gone. Busy or awaiting-input contexts stay alive; anything
     * else is disposed like DELETE would.
     */
    async detach(
      id: string,
    ): Promise<{ found: boolean; kept: boolean; status: BackgroundSessionStatus }> {
      const entry = live.get(id);
      if (!entry) return { found: false, kept: false, status: "idle" };
      const state = entry.ctx.status().state;
      if (entry.ctx.isBusy() || ACTIVE.has(state)) {
        entry.attached = false;
        entry.keptOnce = true;
        entry.ctx.setDetached(true);
        clearGrace(entry);
        changed();
        return { found: true, kept: true, status: state };
      }
      await retire(entry, true);
      return { found: true, kept: false, status: state };
    },

    /** A live detached context for this conversation, if any. */
    findDetached(
      sessionPath: string,
      mode: WorkspaceMode,
      chatAgent: string,
    ): SessionContext | undefined {
      for (const entry of live.values()) {
        if (entry.attached || entry.ctx.mode !== mode) continue;
        if (mode === "chat" && entry.ctx.chatAgent !== chatAgent) continue;
        const p = pathOf(entry.ctx);
        if (p && sameFile(p, sessionPath)) return entry.ctx;
      }
      return undefined;
    },

    attach(id: string): void {
      const entry = live.get(id);
      if (!entry) return;
      entry.attached = true;
      clearGrace(entry);
      entry.ctx.setDetached(false);
      changed();
    },

    /** Locate a live context or stored row by id / conversation file. */
    lookup(target: { id?: string; sessionPath?: string }): {
      ctx?: SessionContext;
      attached: boolean;
      row: BackgroundSessionRow;
    } | null {
      const entry = find(target);
      if (entry) return { ctx: entry.ctx, attached: entry.attached, row: liveRow(entry) };
      const i = findRecordIndex(target);
      return i >= 0 ? { attached: false, row: records[i]! } : null;
    },

    /** Dispose a live context (if any) and drop its record. */
    async remove(target: { id?: string; sessionPath?: string }): Promise<void> {
      const entry = find(target);
      if (entry) {
        const p = pathOf(entry.ctx);
        await retire(entry, false);
        if (p) records = records.filter((r) => !r.sessionPath || !sameFile(r.sessionPath, p));
      }
      const i = findRecordIndex(target);
      if (i >= 0) records.splice(i, 1);
      changed();
    },

    /** Load persisted rows; ones that were active died with the last daemon. */
    async load(): Promise<void> {
      try {
        const parsed = JSON.parse(await fs.readFile(options.file, "utf8")) as {
          sessions?: unknown;
        };
        const t = now();
        records = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
          .filter(isRow)
          .map((r): BackgroundSessionRow => {
            const wasActive = ACTIVE.has(r.status);
            return {
              id: null,
              sessionPath: typeof r.sessionPath === "string" ? r.sessionPath : null,
              cwd: r.cwd,
              mode: r.mode,
              chatAgent: typeof r.chatAgent === "string" ? r.chatAgent : null,
              title: r.title,
              status: wasActive ? "interrupted" : r.status,
              detail: wasActive ? INTERRUPTED_DETAIL : (r.detail ?? null),
              attached: false,
              startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
              updatedAt: r.updatedAt,
            };
          })
          .filter((r) => FINISHED.has(r.status) && t - r.updatedAt < BACKGROUND_FINISHED_TTL_MS)
          .slice(0, BACKGROUND_ROW_CAP);
      } catch {
        records = [];
      }
      await writeNow();
    },

    /** Write rows right now (before shutdown disposes everything). */
    flush(): Promise<void> {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = undefined;
      return writeNow();
    },

    /** After the final flush: stop timers and ignore later changes. */
    close(): void {
      closed = true;
      if (pushTimer) clearTimeout(pushTimer);
      for (const entry of live.values()) clearGrace(entry);
    },
  };
}

export type BackgroundSessionRegistry = ReturnType<typeof createBackgroundSessionRegistry>;

// ── Daemon routes ──────────────────────────────────────────────

function parseTarget(raw: string): { id?: string; sessionPath?: string } | null {
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { id, sessionPath } = body as Record<string, unknown>;
  if (id !== undefined && (typeof id !== "string" || !id)) return null;
  if (sessionPath !== undefined && (typeof sessionPath !== "string" || !sessionPath)) return null;
  if (id === undefined && sessionPath === undefined) return null;
  return { id: id as string | undefined, sessionPath: sessionPath as string | undefined };
}

/** True when `file` is a real path strictly inside `root`. */
async function insideDirectory(file: string, root: string): Promise<boolean> {
  const [realFile, realRoot] = await Promise.all([
    fs.realpath(file).catch(() => path.resolve(file)),
    fs.realpath(root).catch(() => path.resolve(root)),
  ]);
  const rel = path.relative(realRoot, realFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface BackgroundRouteDeps {
  registry: BackgroundSessionRegistry;
  /** The directory every conversation file lives under (`paths.sessionsDir`). */
  sessionsDir: string;
  readBody: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<string | null>;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

/** Handles `/background-sessions*`. Returns true when the request was taken. */
export function handleBackgroundSessionRoutes(
  deps: BackgroundRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  const { registry, json } = deps;
  if (method === "GET" && url === "/background-sessions") {
    json(res, 200, { sessions: registry.rows() });
    return true;
  }
  if (
    method !== "POST" ||
    (url !== "/background-sessions/stop" &&
      url !== "/background-sessions/dismiss" &&
      url !== "/background-sessions/delete")
  ) {
    return false;
  }
  void deps.readBody(req, res).then(async (raw) => {
    if (raw === null) return;
    const target = parseTarget(raw);
    if (!target || (url === "/background-sessions/stop" && !target.id)) {
      json(res, 400, { error: "expected { id } or { sessionPath }" });
      return;
    }
    const found = registry.lookup(target);
    if (!found) {
      json(res, 404, { error: "unknown background session" });
      return;
    }
    try {
      if (url === "/background-sessions/stop") {
        if (!found.ctx) {
          json(res, 404, { error: "not running" });
          return;
        }
        const result = await found.ctx.stop();
        json(res, result === "failed" ? 504 : 200, {
          ok: result !== "failed",
          status: found.ctx.status().state,
        });
        return;
      }
      if (url === "/background-sessions/dismiss") {
        if (found.attached || ACTIVE.has(found.row.status)) {
          json(res, 409, { error: "still running or open in a window", status: found.row.status });
          return;
        }
        await registry.remove(target);
        json(res, 200, { ok: true });
        return;
      }
      // delete: stop, dispose, forget, and remove the conversation file.
      const file = found.row.sessionPath;
      if (file && !(await insideDirectory(file, deps.sessionsDir))) {
        json(res, 400, { error: "conversation file is outside the sessions folder" });
        return;
      }
      if (found.ctx) await found.ctx.stop().catch(() => "failed");
      await registry.remove(target);
      if (file) await fs.rm(file, { force: true }).catch(() => {});
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return true;
}
