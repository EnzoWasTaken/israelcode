import { describe, expect, it } from "vitest";
import type { RecentSession } from "./agent";
import {
  formatSessionTime,
  groupSessions,
  searchSessions,
  sessionGroupKey,
  sessionPathKey,
} from "./session-browser-model";

// Wednesday 11 Nov 2026, 15:00 local time.
const NOW = new Date(2026, 10, 11, 15, 0, 0);
const at = (days: number, hour: number, minute = 0): number =>
  new Date(2026, 10, 11 - days, hour, minute).getTime();
const row = (id: string, lastActiveMs?: number, preview = id): RecentSession => ({
  id,
  path: `/s/${id}.jsonl`,
  preview,
  lastActiveDisplay: "x",
  lastActiveMs,
  messageCount: 1,
});

describe("sessionGroupKey", () => {
  it("buckets by the local calendar day", () => {
    expect(sessionGroupKey(at(0, 0, 1), NOW)).toBe("today");
    expect(sessionGroupKey(at(1, 23, 59), NOW)).toBe("yesterday");
    expect(sessionGroupKey(at(1, 0, 0), NOW)).toBe("yesterday");
    expect(sessionGroupKey(at(2, 12), NOW)).toBe("week");
    expect(sessionGroupKey(at(6, 0, 0), NOW)).toBe("week");
    expect(sessionGroupKey(at(7, 12), NOW)).toBe("earlier");
  });
});

describe("groupSessions", () => {
  it("groups Today / Yesterday / This week / Earlier in order, skipping empty ones", () => {
    const groups = groupSessions(
      [row("a", at(0, 14)), row("b", at(0, 9)), row("c", at(3, 9)), row("d", at(40, 9))],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["This week", ["c"]],
      ["Earlier", ["d"]],
    ]);
  });

  it("falls back to one ungrouped list when a row has no lastActiveMs", () => {
    const groups = groupSessions([row("a", at(0, 14)), row("b")], NOW);
    expect(groups).toEqual([
      { key: "all", label: null, sessions: [row("a", at(0, 14)), row("b")] },
    ]);
  });

  it("returns nothing for no sessions", () => {
    expect(groupSessions([], NOW)).toEqual([]);
  });
});

describe("formatSessionTime", () => {
  const locale = "en-GB";
  it("is relative today", () => {
    expect(formatSessionTime(NOW.getTime() - 4 * 60_000, NOW, locale)).toBe(
      new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(
        -4,
        "minute",
      ),
    );
    expect(formatSessionTime(NOW.getTime() - 3 * 3_600_000, NOW, locale)).toContain("3");
    expect(formatSessionTime(NOW.getTime() - 10_000, NOW, locale)).toBe(
      new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second"),
    );
  });
  it("is a clock time yesterday", () => {
    expect(formatSessionTime(at(1, 18, 42), NOW, locale)).toBe("18:42");
  });
  it("is a short weekday this week", () => {
    expect(formatSessionTime(at(2, 10), NOW, locale)).toBe("Mon");
  });
  it("is a short date earlier, with the year only when it differs", () => {
    expect(formatSessionTime(new Date(2026, 9, 30, 9).getTime(), NOW, locale)).toBe("30 Oct");
    expect(formatSessionTime(new Date(2024, 9, 30, 9).getTime(), NOW, locale)).toBe("30 Oct 2024");
  });
});

describe("searchSessions", () => {
  it("filters by title, case-insensitive, keeping order", () => {
    const rows = [row("1", 1, "Fix the Cart test"), row("2", 1, "Docs"), row("3", 1, "cart api")];
    expect(searchSessions(rows, "CART").map((s) => s.id)).toEqual(["1", "3"]);
    expect(searchSessions(rows, "  ")).toBe(rows);
  });
});

it("sessionPathKey matches Windows and POSIX separators", () => {
  expect(sessionPathKey("C:\\S\\a.jsonl")).toBe(sessionPathKey("c:/s/A.jsonl"));
});
