import { describe, expect, it } from "vitest";
import {
  earlierStartId,
  TURN_PAGE,
  turnStartIndex,
  WARM_FIRST_TURNS,
  WARM_STEP_TURNS,
  windowStartIndex,
  type WindowItem,
} from "./transcript-window";

/** `turns` user messages, each followed by `replies` assistant rows. */
function chat(turns: number, replies = 2, lead = 0): WindowItem[] {
  const items: WindowItem[] = [];
  let id = 1;
  for (let i = 0; i < lead; i++) items.push({ id: id++, kind: "notice" });
  for (let t = 0; t < turns; t++) {
    items.push({ id: id++, kind: "user" });
    for (let r = 0; r < replies; r++) items.push({ id: id++, kind: "assistant" });
  }
  return items;
}

describe("turnStartIndex", () => {
  it("starts the window at the user message that opens the oldest turn in range", () => {
    const items = chat(30);
    const start = turnStartIndex(items, TURN_PAGE);
    expect(items[start]?.kind).toBe("user");
    expect(items.slice(start).filter((i) => i.kind === "user")).toHaveLength(TURN_PAGE);
  });

  it("renders a short chat whole, including rows before the first message", () => {
    expect(turnStartIndex(chat(5, 2, 3), TURN_PAGE)).toBe(0);
  });

  it("counts back from an end index", () => {
    const items = chat(50);
    const latest = turnStartIndex(items, TURN_PAGE);
    const earlier = turnStartIndex(items, TURN_PAGE, latest);
    expect(items.slice(earlier, latest).filter((i) => i.kind === "user")).toHaveLength(TURN_PAGE);
  });
});

describe("windowStartIndex", () => {
  it("follows the newest page of turns when not anchored", () => {
    const items = chat(30);
    expect(windowStartIndex(items, null)).toBe(turnStartIndex(items, TURN_PAGE));
  });

  it("holds an anchored start in place while new turns arrive", () => {
    const items = chat(30);
    const anchor = items[windowStartIndex(items, null)]?.id ?? 0;
    const grown = [...items, { id: 1000, kind: "user" }, { id: 1001, kind: "assistant" }];
    expect(grown[windowStartIndex(grown, anchor)]?.id).toBe(anchor);
  });

  it("falls back to the newest page when the anchor is gone", () => {
    const items = chat(30);
    expect(windowStartIndex(items, -5)).toBe(turnStartIndex(items, TURN_PAGE));
  });
});

describe("earlierStartId", () => {
  it("steps back one page of turns", () => {
    const items = chat(50);
    const start = windowStartIndex(items, null);
    const id = earlierStartId(items, start);
    const next = items.findIndex((i) => i.id === id);
    expect(items.slice(next, start).filter((i) => i.kind === "user")).toHaveLength(TURN_PAGE);
  });

  it("reaches the very first row on the last page", () => {
    const items = chat(25, 2, 2);
    const start = windowStartIndex(items, null);
    expect(earlierStartId(items, start)).toBe(items[0]?.id);
  });

  it("has nothing earlier once the whole chat is shown", () => {
    expect(earlierStartId(chat(5), 0)).toBeNull();
  });
});

describe("warm window on open", () => {
  it("mounts only the newest turns first, then grows to the full page", () => {
    const items = chat(60);
    const first = windowStartIndex(items, null, WARM_FIRST_TURNS);
    expect(items.slice(first).filter((i) => i.kind === "user")).toHaveLength(WARM_FIRST_TURNS);
    const shown = items.slice(first);
    expect(items[items.length - 1]).toBe(shown[shown.length - 1]);
    let turns = WARM_FIRST_TURNS;
    let prev = first;
    while (turns < TURN_PAGE) {
      turns = Math.min(TURN_PAGE, turns + WARM_STEP_TURNS);
      const next = windowStartIndex(items, null, turns);
      // Growth only ever adds older rows above; rows already shown stay.
      expect(next).toBeLessThan(prev);
      prev = next;
    }
    expect(prev).toBe(windowStartIndex(items, null));
  });

  it("a reader's held warm window stays put as replies arrive below", () => {
    const items = chat(60);
    const start = windowStartIndex(items, null, WARM_FIRST_TURNS);
    const held = items[start]!.id;
    const more = [...items, { id: 9999, kind: "user" }, { id: 10000, kind: "assistant" }];
    expect(windowStartIndex(more, held, WARM_FIRST_TURNS)).toBe(start);
  });
});
