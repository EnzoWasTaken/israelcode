import {
  addDayUsage,
  BudgetGuard,
  RunawayDetector,
  type BudgetConfig,
  type BudgetStatus,
} from "../core/budget-guard.js";
import type { EventBus } from "../core/event-bus.js";
import type { LoopBreakStats } from "../core/loop-breaker.js";
import { log } from "../core/logger.js";
import type { SubAgentTokenUsage } from "../tools/subagent-shared.js";

/** What `/budget`, the ready frame and `budget_state` events carry. */
export interface BudgetStatePayload {
  config: BudgetConfig;
  status: BudgetStatus;
}

export interface BudgetController {
  statePayload(): BudgetStatePayload;
  /** Count a turn of the main model (or a child's delta) and act on the result. */
  recordUsage(usage: { inputTokens: number; outputTokens: number }): Promise<void>;
  /** A child's cumulative snapshot: only the growth since the last one counts. */
  recordChildSnapshot(agentId: string, usage: SubAgentTokenUsage): Promise<void>;
  /** Ask the runaway detector whether this run is still worth its tokens. */
  checkRunaway(): Promise<void>;
  /** New caps from the user: saved by the route, applied here. */
  configure(config: BudgetConfig): BudgetStatePayload;
  /** "Continue anyway." */
  allowOverride(): BudgetStatePayload;
  /** A run begins: it may be stopped once for a cap and once for running away. */
  noteRunStart(): void;
  /** Subscribe to the session's events. */
  attach(bus: EventBus): void;
}

export interface BudgetControllerOptions {
  /** Normalized project cwd: the ledger's key. */
  projectKey: string;
  config: BudgetConfig;
  /** Today's ledger figure for the project at session start. */
  dayUsed: number;
  broadcast: (type: string, data: unknown) => void;
  /** Cancel the current run the way the Stop button does. */
  stopRun: () => Promise<void>;
  /** The session's loop-break signals (`AgentSession.getLoopBreakStats`). */
  loopBreakStats: () => LoopBreakStats & { nudgesThisRun: number };
  /** Ledger location overrides for tests. */
  ledger?: { home?: string; today?: () => string };
}

/**
 * Wires a `BudgetGuard` and a `RunawayDetector` to one coding session: counts
 * every turn of the main model and every child's growth toward the session
 * and day totals, writes the day ledger, tells the app where the meter stands
 * and stops the run when a cap is used up or the loop-breaker has given up.
 */
export function createBudgetController(opts: BudgetControllerOptions): BudgetController {
  const guard = new BudgetGuard(opts.config, { dayUsed: opts.dayUsed });
  const detector = new RunawayDetector();
  const childSeen = new Map<string, { input: number; output: number }>();
  // Ledger writes and stop decisions run in order, one at a time.
  let chain: Promise<void> = Promise.resolve();
  let stopping = false;
  // One stop of each kind per run: events keep arriving while a cancel drains.
  const stoppedThisRun = new Set<"budget_exceeded" | "runaway_stopped">();

  function statePayload(): BudgetStatePayload {
    return { config: guard.getConfig(), status: guard.status() };
  }

  function ledgerOpts(): { home?: string; today?: string } {
    return {
      ...(opts.ledger?.home ? { home: opts.ledger.home } : {}),
      ...(opts.ledger?.today ? { today: opts.ledger.today() } : {}),
    };
  }

  async function stop(type: "budget_exceeded" | "runaway_stopped", data: unknown): Promise<void> {
    if (stopping || stoppedThisRun.has(type)) return;
    stopping = true;
    stoppedThisRun.add(type);
    try {
      opts.broadcast(type, data);
      await opts.stopRun();
    } catch (err) {
      log("ERROR", "budget", "stopping the run failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      stopping = false;
    }
  }

  async function record(usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    const tokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
    let dayTotal: number | undefined;
    try {
      dayTotal = await addDayUsage(opts.projectKey, tokens, ledgerOpts());
    } catch (err) {
      // The guard keeps its own running day figure when the ledger is unwritable.
      log("WARN", "budget", "day ledger write failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const result = guard.recordTurn(usage, dayTotal);
    opts.broadcast("budget_state", result.status);
    for (const crossing of result.crossings) {
      log("INFO", "budget", "budget warning", {
        level: crossing.level,
        scope: crossing.scope,
        used: String(crossing.used),
        cap: String(crossing.cap),
      });
      opts.broadcast("budget_warning", crossing);
    }
    if (result.stop) {
      log("WARN", "budget", "budget used up — stopping the run", {
        sessionUsed: String(result.status.sessionUsed),
        sessionCap: String(result.status.sessionCap),
        dayUsed: String(result.status.dayUsed),
        dayCap: String(result.status.dayCap),
      });
      await stop("budget_exceeded", { status: result.status });
    }
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    chain = chain.then(work, work);
    return chain;
  }

  const controller: BudgetController = {
    statePayload,
    recordUsage: (usage) => enqueue(() => record(usage)),
    recordChildSnapshot: (agentId, usage) => {
      const last = childSeen.get(agentId) ?? { input: 0, output: 0 };
      const input = Math.max(0, (usage.input ?? 0) - last.input);
      const output = Math.max(0, (usage.output ?? 0) - last.output);
      childSeen.set(agentId, { input: usage.input ?? 0, output: usage.output ?? 0 });
      if (input + output === 0) return Promise.resolve();
      return enqueue(() => record({ inputTokens: input, outputTokens: output }));
    },
    checkRunaway: () =>
      enqueue(async () => {
        if (!guard.hardStopOnRunaway) return;
        const stats = opts.loopBreakStats();
        const decision = detector.evaluate(stats, stats.nudgesThisRun);
        if (!decision.shouldHardStop) return;
        log("WARN", "budget", "runaway run — stopping", { reasons: decision.reasons.join("; ") });
        await stop("runaway_stopped", { reasons: decision.reasons });
      }),
    configure: (config) => {
      guard.configure(config);
      const payload = statePayload();
      opts.broadcast("budget_state", payload.status);
      return payload;
    },
    allowOverride: () => {
      const status = guard.allowOverride();
      log("WARN", "budget", "budget cap overridden — continuing past it", {
        sessionUsed: String(status.sessionUsed),
        dayUsed: String(status.dayUsed),
      });
      opts.broadcast("budget_state", status);
      return statePayload();
    },
    noteRunStart: () => {
      stoppedThisRun.clear();
    },
    attach: (bus) => {
      bus.on("turn_end", (d) => void controller.recordUsage(d.usage));
      bus.on(
        "subagent_state",
        (d) => void controller.recordChildSnapshot(d.agent_id, d.token_usage),
      );
      // Nudges are the detector's first signal; after the breaker's two stages
      // are spent the streaks grow unchecked, so every tool result is checked too.
      bus.on("hook", (d) => {
        if (d.kind === "loop_break") void controller.checkRunaway();
      });
      bus.on("tool_call_end", () => void controller.checkRunaway());
    },
  };
  return controller;
}
