/**
 * Compaction control: the user's per-project say over when the context is
 * compacted and what must survive it. Pure helpers shared by the session
 * (focus merge, rewind-point prompt), the sidecar routes and the app's
 * settings file. See docs/adr/0009-compaction-control.md.
 */

/** Window fractions the app offers as one-click thresholds. */
export const COMPACTION_THRESHOLD_PRESETS = [0.6, 0.7, 0.85] as const;

export const COMPACTION_THRESHOLD_MIN = 0.3;
export const COMPACTION_THRESHOLD_MAX = 0.95;
/** Matches the global `compactAtTokens` floor in settings-manager. */
export const COMPACTION_AT_TOKENS_MIN = 20_000;
export const MAX_PINNED_FACTS = 20;
export const MAX_PINNED_FACT_LENGTH = 200;

/** A project's compaction preference, as saved in gg-app.json. */
export interface CompactionPref {
  /** Fraction of the window that triggers compaction; absent → the global setting. */
  threshold?: number;
  /** Absolute token trigger; null/absent → the global setting. */
  atTokens?: number | null;
  /** Facts and decisions the summariser must keep verbatim. */
  pins: string[];
}

/** Trim, clamp and dedupe a raw preference; null when nothing of it is usable. */
export function normalizeCompactionPref(value: unknown): CompactionPref | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { threshold?: unknown; atTokens?: unknown; pins?: unknown };
  const out: CompactionPref = { pins: normalizePins(raw.pins) };
  const threshold = normalizeThreshold(raw.threshold);
  if (threshold !== undefined) out.threshold = threshold;
  const atTokens = normalizeAtTokens(raw.atTokens);
  if (atTokens !== undefined) out.atTokens = atTokens;
  if (out.threshold === undefined && out.atTokens === undefined && out.pins.length === 0) {
    return null;
  }
  return out;
}

/** A window fraction between 0.3 and 0.95 (rounded to 2 places); undefined otherwise. */
export function normalizeThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 100) / 100;
  if (rounded < COMPACTION_THRESHOLD_MIN || rounded > COMPACTION_THRESHOLD_MAX) return undefined;
  return rounded;
}

/** A positive integer token count ≥ 20k; `null` means "no absolute trigger"; else undefined. */
export function normalizeAtTokens(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const whole = Math.floor(value);
  if (whole < COMPACTION_AT_TOKENS_MIN) return undefined;
  return whole;
}

/** Non-empty trimmed lines, each capped at 200 chars, at most 20, no duplicates. */
export function normalizePins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().slice(0, MAX_PINNED_FACT_LENGTH);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_PINNED_FACTS) break;
  }
  return out;
}

/**
 * The summariser's `focus`: the pinned facts first, then what the user asked
 * for this time. Undefined when there is neither.
 */
export function buildCompactionFocus(
  pins: readonly string[],
  userFocus?: string,
): string | undefined {
  const facts = normalizePins([...pins]);
  const extra = userFocus?.trim();
  const parts: string[] = [];
  if (facts.length > 0) {
    parts.push(`Keep these facts verbatim:\n${facts.map((fact) => `- ${fact}`).join("\n")}`);
  }
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const COMPACTION_REWIND_PREFIX = "Before compaction";

/** The rewind point's label, as the rewind picker shows it. */
export function compactionRewindPrompt(messageCount: number): string {
  const n = Math.max(0, Math.floor(messageCount));
  return `${COMPACTION_REWIND_PREFIX} (${n} ${n === 1 ? "message" : "messages"})`;
}
