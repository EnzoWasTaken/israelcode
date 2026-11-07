import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_DIR_NAME, withFileLock } from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";
import type { LoopBreakStats } from "./loop-breaker.js";

/**
 * Budget guardrails: token caps for one session and for the project's day,
 * with warnings at 50% and 80% of each cap and a hard stop at 100%. Budgets
 * are in TOKENS: there is no authoritative provider pricing in Israel Code
 * (`TurnMetricPayload.cost` is always "unavailable"), so the guard never
 * speaks in dollars. Pure state here; the sidecar wires it to the session's
 * `turn_end` events, cancels the run and talks to the app.
 */

export interface BudgetConfig {
  /** Tokens (input + output) this window's session may spend; unset: no cap. */
  sessionTokens?: number;
  /** Tokens this project may spend today, across windows; unset: no cap. */
  dayTokens?: number;
  /** Stop a run the runaway detector calls hopeless instead of letting it churn. */
  hardStopOnRunaway: boolean;
}

export type BudgetWarning = "warn50" | "warn80";
export type BudgetLevel = "ok" | BudgetWarning | "exceeded";
export type BudgetScope = "session" | "day";

export interface BudgetStatus {
  sessionUsed: number;
  sessionCap: number | null;
  dayUsed: number;
  dayCap: number | null;
  level: BudgetLevel;
  /** The user chose "Continue anyway": caps no longer stop this session. */
  overridden: boolean;
}

/** One threshold crossed by a turn, with the cap it belongs to. */
export interface BudgetCrossing {
  level: BudgetWarning;
  scope: BudgetScope;
  cap: number;
  used: number;
}

export interface BudgetTurnResult {
  /** 50% / 80% thresholds crossed by this turn (each fires once per cap). */
  warnings: BudgetWarning[];
  /** The same crossings with the cap they belong to, for the app's toast. */
  crossings: BudgetCrossing[];
  /** A cap is used up and the user has not said to continue: stop the run. */
  stop: boolean;
  status: BudgetStatus;
}

/** Every pair of thresholds in order; a turn can jump past both at once. */
const WARN_THRESHOLDS: ReadonlyArray<{ level: BudgetWarning; ratio: number }> = [
  { level: "warn50", ratio: 0.5 },
  { level: "warn80", ratio: 0.8 },
];

function positiveCap(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function turnTokens(usage: { inputTokens: number; outputTokens: number }): number {
  const input = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
  const output = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
  return input + output;
}

function levelFor(used: number, cap: number | null): BudgetLevel {
  if (cap === null) return "ok";
  if (used >= cap) return "exceeded";
  if (used >= cap * 0.8) return "warn80";
  if (used >= cap * 0.5) return "warn50";
  return "ok";
}

const LEVEL_RANK: Readonly<Record<BudgetLevel, number>> = {
  ok: 0,
  warn50: 1,
  warn80: 2,
  exceeded: 3,
};

export class BudgetGuard {
  private config: BudgetConfig;
  private sessionUsed = 0;
  private dayUsed: number;
  private overridden = false;
  private fired: Record<BudgetScope, Set<BudgetWarning>> = {
    session: new Set(),
    day: new Set(),
  };

  constructor(config: BudgetConfig, opts: { dayUsed?: number } = {}) {
    this.config = { ...config };
    this.dayUsed = Math.max(0, opts.dayUsed ?? 0);
    this.armCrossedThresholds();
  }

  get hardStopOnRunaway(): boolean {
    return this.config.hardStopOnRunaway;
  }

  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * Count one turn. `dayUsedAfter` is the project's day total after this turn
   * when a shared ledger is the authority (other windows spend too); without
   * it the guard adds the turn to its own running day figure.
   */
  recordTurn(
    usage: { inputTokens: number; outputTokens: number },
    dayUsedAfter?: number,
  ): BudgetTurnResult {
    const tokens = turnTokens(usage);
    this.sessionUsed += tokens;
    this.dayUsed =
      typeof dayUsedAfter === "number" && Number.isFinite(dayUsedAfter)
        ? Math.max(0, dayUsedAfter)
        : this.dayUsed + tokens;
    const crossings = [...this.takeCrossings("session"), ...this.takeCrossings("day")];
    const status = this.status();
    return {
      warnings: crossings.map((c) => c.level),
      crossings,
      stop: status.level === "exceeded" && !this.overridden,
      status,
    };
  }

  status(): BudgetStatus {
    const sessionCap = positiveCap(this.config.sessionTokens);
    const dayCap = positiveCap(this.config.dayTokens);
    const session = levelFor(this.sessionUsed, sessionCap);
    const day = levelFor(this.dayUsed, dayCap);
    const level = LEVEL_RANK[session] >= LEVEL_RANK[day] ? session : day;
    return {
      sessionUsed: this.sessionUsed,
      sessionCap,
      dayUsed: this.dayUsed,
      dayCap,
      level,
      overridden: this.overridden,
    };
  }

  /** "Continue anyway": the caps stop warning and stopping until re-armed. */
  allowOverride(): BudgetStatus {
    this.overridden = true;
    return this.status();
  }

  /** New caps: the override is lifted and thresholds already behind us stay quiet. */
  configure(config: BudgetConfig): BudgetStatus {
    this.config = { ...config };
    this.overridden = false;
    this.fired = { session: new Set(), day: new Set() };
    this.armCrossedThresholds();
    return this.status();
  }

  private capFor(scope: BudgetScope): number | null {
    return positiveCap(scope === "session" ? this.config.sessionTokens : this.config.dayTokens);
  }

  private usedFor(scope: BudgetScope): number {
    return scope === "session" ? this.sessionUsed : this.dayUsed;
  }

  /** Thresholds the current totals are already past never fire later. */
  private armCrossedThresholds(): void {
    for (const scope of ["session", "day"] as const) {
      const cap = this.capFor(scope);
      if (cap === null) continue;
      for (const { level, ratio } of WARN_THRESHOLDS) {
        if (this.usedFor(scope) >= cap * ratio) this.fired[scope].add(level);
      }
    }
  }

  private takeCrossings(scope: BudgetScope): BudgetCrossing[] {
    const cap = this.capFor(scope);
    if (cap === null || this.overridden) return [];
    const used = this.usedFor(scope);
    const out: BudgetCrossing[] = [];
    for (const { level, ratio } of WARN_THRESHOLDS) {
      if (used >= cap * ratio && !this.fired[scope].has(level)) {
        this.fired[scope].add(level);
        // Past the cap itself the stop speaks; a warning on top is noise.
        if (used < cap) out.push({ level, scope, cap, used });
      }
    }
    return out;
  }
}

// ── Day ledger: ~/.israelcode/budget-ledger.json ──────────────────────────

export interface BudgetLedger {
  version: 1;
  /** Tokens spent per project (normalized cwd) per local day, YYYY-MM-DD. */
  days: Record<string, Record<string, number>>;
}

export const LEDGER_KEEP_DAYS = 14;

export function budgetLedgerFile(home: string = os.homedir()): string {
  return path.join(home, APP_DIR_NAME, "budget-ledger.json");
}

/** Local calendar day as YYYY-MM-DD (budgets reset at the user's midnight). */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyLedger(): BudgetLedger {
  return { version: 1, days: {} };
}

/** Keep only well-formed entries so a hand-edited file can't break a turn. */
function parseLedger(raw: unknown): BudgetLedger {
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1) {
    return emptyLedger();
  }
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== "object" || Array.isArray(days)) return emptyLedger();
  const out = emptyLedger();
  for (const [day, projects] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !projects || typeof projects !== "object") continue;
    const row: Record<string, number> = {};
    for (const [key, tokens] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) row[key] = tokens;
    }
    out.days[day] = row;
  }
  return out;
}

/** Drop days older than `keepDays` before `today` (string compare works on ISO days). */
export function pruneLedger(
  ledger: BudgetLedger,
  today: string,
  keepDays: number = LEDGER_KEEP_DAYS,
): BudgetLedger {
  const cutoff = new Date(`${today}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const floor = localDay(cutoff);
  const days: Record<string, Record<string, number>> = {};
  for (const [day, projects] of Object.entries(ledger.days)) {
    if (day >= floor) days[day] = projects;
  }
  return { version: 1, days };
}

export async function readBudgetLedger(file: string): Promise<BudgetLedger> {
  try {
    return parseLedger(JSON.parse(await fs.readFile(file, "utf-8")) as unknown);
  } catch {
    return emptyLedger();
  }
}

/** Tokens `projectKey` spent on `today` according to the ledger on disk. */
export async function readDayUsage(
  projectKey: string,
  opts: { home?: string; today?: string } = {},
): Promise<number> {
  const ledger = await readBudgetLedger(budgetLedgerFile(opts.home));
  return ledger.days[opts.today ?? localDay()]?.[projectKey] ?? 0;
}

/**
 * Add `tokens` to today's figure for `projectKey` under the shared file lock
 * (several windows of one project spend at once) and return the new day total.
 * Prunes days older than the keep window on every write.
 */
export async function addDayUsage(
  projectKey: string,
  tokens: number,
  opts: { home?: string; today?: string } = {},
): Promise<number> {
  const file = budgetLedgerFile(opts.home);
  const today = opts.today ?? localDay();
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const ledger = pruneLedger(await readBudgetLedger(file), today);
    const row = ledger.days[today] ?? {};
    const total = (row[projectKey] ?? 0) + Math.max(0, Math.floor(tokens));
    row[projectKey] = total;
    ledger.days[today] = row;
    await atomicWrite(file, JSON.stringify(ledger, null, 2));
    return total;
  });
}

// ── Runaway detector ────────────────────────────────────────────────────────

export interface RunawayDecision {
  shouldHardStop: boolean;
  reasons: string[];
}

/** Loop-break nudges in one run before the run is called hopeless. */
export const RUNAWAY_NUDGE_LIMIT = 3;
/** Failed tool calls in a row, well past the nudging breaker's 3. */
export const RUNAWAY_FAILURE_LIMIT = 8;
/** Identical no-progress calls in a row, past the nudging breaker's 3. */
export const RUNAWAY_NO_PROGRESS_LIMIT = 6;

/**
 * Decides when a stuck run should be STOPPED rather than nudged. The
 * loop-breaker (`loop-breaker.ts`) only steers the model; once it has used
 * its nudges, or the streaks grow far past what a nudge should have fixed,
 * the run is burning tokens for nothing.
 */
export class RunawayDetector {
  evaluate(stats: LoopBreakStats, nudgesThisRun: number): RunawayDecision {
    const reasons: string[] = [];
    if (nudgesThisRun >= RUNAWAY_NUDGE_LIMIT) {
      reasons.push(`${nudgesThisRun} loop-break nudges in one run with no change`);
    }
    if (stats.consecutiveFailures >= RUNAWAY_FAILURE_LIMIT) {
      reasons.push(`${stats.consecutiveFailures} failed tool calls in a row`);
    }
    if (stats.repeatedNoProgressCalls >= RUNAWAY_NO_PROGRESS_LIMIT) {
      reasons.push(
        `the same tool call returned the same result ${stats.repeatedNoProgressCalls} times`,
      );
    }
    return { shouldHardStop: reasons.length > 0, reasons };
  }
}
