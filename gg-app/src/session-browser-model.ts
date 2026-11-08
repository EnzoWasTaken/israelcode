import type { ChatAgentId, RecentSession } from "./agent";
import { fuzzyMatch } from "./commands/fuzzy";

/** Date buckets the session browser groups rows into, newest first. */
export type SessionGroupKey = "today" | "yesterday" | "week" | "earlier";

export const GROUP_LABELS: Record<SessionGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

export interface SessionGroup {
  key: SessionGroupKey | "all";
  /** Null for the single ungrouped list (an older sidecar sent no dates). */
  label: string | null;
  sessions: RecentSession[];
}

/** The chat agents' display names, as the chat header shows them. */
export const CHAT_AGENT_LABELS: Record<ChatAgentId, string> = {
  general: "General",
  therapist: "Therapist",
  research: "Research",
};

const DAY_MS = 86_400_000;

function startOfDay(at: Date, daysBack = 0): number {
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - daysBack);
  return day.getTime();
}

/** Which bucket a last-active time falls in, by the local calendar. */
export function sessionGroupKey(ms: number, now: Date): SessionGroupKey {
  if (ms >= startOfDay(now)) return "today";
  if (ms >= startOfDay(now, 1)) return "yesterday";
  if (ms >= startOfDay(now, 6)) return "week";
  return "earlier";
}

/**
 * Group sessions Today / Yesterday / This week / Earlier, keeping the given
 * order inside each group. When any row lacks `lastActiveMs` (an older
 * sidecar), the list stays one ungrouped group.
 */
export function groupSessions(sessions: RecentSession[], now: Date): SessionGroup[] {
  if (sessions.length === 0) return [];
  if (sessions.some((s) => typeof s.lastActiveMs !== "number")) {
    return [{ key: "all", label: null, sessions }];
  }
  const order: SessionGroupKey[] = ["today", "yesterday", "week", "earlier"];
  const buckets = new Map<SessionGroupKey, RecentSession[]>();
  for (const session of sessions) {
    const key = sessionGroupKey(session.lastActiveMs ?? 0, now);
    buckets.set(key, [...(buckets.get(key) ?? []), session]);
  }
  return order.flatMap((key) => {
    const rows = buckets.get(key);
    return rows ? [{ key, label: GROUP_LABELS[key], sessions: rows }] : [];
  });
}

/**
 * The row's time: relative today ("4m ago"), a clock time yesterday, a short
 * weekday this week, a short date earlier. `locale` defaults to the user's.
 */
export function formatSessionTime(ms: number, now: Date, locale?: string): string {
  const key = sessionGroupKey(ms, now);
  if (key === "today") {
    const minutes = Math.floor(Math.max(0, now.getTime() - ms) / 60_000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    if (minutes < 1) return rtf.format(0, "second");
    if (minutes < 60) return rtf.format(-minutes, "minute");
    return rtf.format(-Math.floor(minutes / 60), "hour");
  }
  const at = new Date(ms);
  if (key === "yesterday") {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  }
  if (key === "week") return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  const sameYear = at.getFullYear() === now.getFullYear() || now.getTime() - ms < 180 * DAY_MS;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
}

/** Rows whose title contains the query, case-insensitive; order kept. */
export function searchSessions(sessions: RecentSession[], query: string): RecentSession[] {
  if (!query.trim()) return sessions;
  return sessions.filter((s) => fuzzyMatch(query, s.preview, true) !== null);
}

/** Match background-session paths against listed ones across separators/case. */
export function sessionPathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
