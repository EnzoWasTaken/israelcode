import { log } from "../core/logger.js";
import type { CompactionPref } from "../core/compaction-control.js";

/** `getCompactionInfo()` on the session: where it stands against its trigger. */
export interface CompactionInfo {
  threshold: number;
  atTokens: number | null;
  contextWindow: number;
  activeTokens: number;
  lastCompactionAt?: number;
  lastCompactionRewindId: string | null;
}

/** What `/compaction`, the ready frame and `compaction_state` events carry. */
export interface CompactionStatePayload {
  pref: CompactionPref;
  info: CompactionInfo;
}

export interface CompactionOutcome {
  compacted: boolean;
  originalCount: number;
  newCount: number;
}

/** The slice of AgentSession the controller drives. */
export interface CompactionSessionLike {
  eventBus: {
    on(
      event: "compaction_end",
      handler: (d: { compacted: boolean; originalCount: number; newCount: number }) => void,
    ): () => void;
  };
  setCompactionOverride(override: { threshold?: number; atTokens?: number | null }): void;
  getCompactionInfo(): CompactionInfo;
  compact(
    existingCredentials?: undefined,
    mode?: "manual" | "automatic" | "forced",
    focus?: string,
  ): Promise<void>;
  undoLastCompaction(): Promise<{ restoredCount: number; newCount: number }>;
}

export interface CompactionController {
  readonly pref: CompactionPref;
  statePayload(): CompactionStatePayload;
  /** Apply a saved preference to the live session and tell the app. */
  setPref(pref: CompactionPref): CompactionStatePayload;
  /** Re-broadcast the state (after a compaction settles). */
  announce(): void;
  /** Compact now; the caller wraps this in the run lifecycle. */
  compactNow(focus?: string): Promise<CompactionOutcome>;
  /** Restore the conversation from before the last compaction; null when there is none. */
  undo(): Promise<{ restoredCount: number; newCount: number } | null>;
}

export interface CompactionControllerOptions {
  session: CompactionSessionLike;
  pref: CompactionPref;
  broadcast: (type: string, data: unknown) => void;
}

export function createCompactionController(
  opts: CompactionControllerOptions,
): CompactionController {
  let pref = opts.pref;
  const { session } = opts;

  function apply(): void {
    session.setCompactionOverride({
      ...(pref.threshold !== undefined ? { threshold: pref.threshold } : {}),
      ...(pref.atTokens !== undefined ? { atTokens: pref.atTokens } : {}),
    });
  }
  apply();

  function statePayload(): CompactionStatePayload {
    return { pref, info: session.getCompactionInfo() };
  }

  return {
    get pref() {
      return pref;
    },
    statePayload,
    setPref: (next) => {
      pref = next;
      apply();
      const payload = statePayload();
      opts.broadcast("compaction_state", payload);
      return payload;
    },
    announce: () => {
      opts.broadcast("compaction_state", statePayload());
    },
    compactNow: async (focus) => {
      let outcome: CompactionOutcome = { compacted: false, originalCount: 0, newCount: 0 };
      const off = session.eventBus.on("compaction_end", (d) => {
        outcome = { compacted: d.compacted, originalCount: d.originalCount, newCount: d.newCount };
      });
      try {
        await session.compact(undefined, "manual", focus);
      } finally {
        off();
      }
      log("INFO", "compaction", "manual compaction finished", {
        compacted: String(outcome.compacted),
        originalCount: String(outcome.originalCount),
        newCount: String(outcome.newCount),
      });
      return outcome;
    },
    undo: async () => {
      if (session.getCompactionInfo().lastCompactionAt === undefined) return null;
      const restored = await session.undoLastCompaction();
      log("INFO", "compaction", "compaction undone", {
        restored: String(restored.restoredCount),
      });
      opts.broadcast("compaction_state", statePayload());
      return restored;
    },
  };
}
