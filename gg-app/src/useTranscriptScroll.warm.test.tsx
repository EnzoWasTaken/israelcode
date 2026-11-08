// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import type { Item } from "./transcript-item";
import { TURN_PAGE, WARM_FIRST_TURNS } from "./transcript-window";
import { useTranscriptScroll } from "./useTranscriptScroll";

function chat(turns: number): Item[] {
  const items: Item[] = [];
  let id = 1;
  for (let t = 0; t < turns; t++) {
    items.push({ id: id++, kind: "user" } as unknown as Item);
    items.push({ id: id++, kind: "assistant" } as unknown as Item);
  }
  return items;
}

const chatLayout = { settle: vi.fn(), cancel: vi.fn() } as unknown as ReturnType<
  typeof createChatLayoutMotion
>;

function setup() {
  const scrollRef = { current: null };
  return renderHook(({ list }) => useTranscriptScroll({ items: list, scrollRef, chatLayout }), {
    initialProps: { list: [] as Item[] },
  });
}

const users = (rows: readonly Item[]) => rows.filter((r) => r.kind === "user").length;

describe("opening a long chat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mounts the newest turns first, then the rest of the page above them", async () => {
    const items = chat(80);
    const view = setup();
    act(() => {
      view.result.current.startWarmMount();
      view.rerender({ list: items });
    });
    const first = view.result.current.visibleItems;
    expect(users(first)).toBe(WARM_FIRST_TURNS);
    expect(first[first.length - 1]?.id).toBe(items[items.length - 1]?.id);
    for (let i = 0; i < 10; i++) await act(async () => vi.advanceTimersByTimeAsync(20));
    const full = view.result.current.visibleItems;
    expect(users(full)).toBe(TURN_PAGE);
    // The first rows are the same objects, just with older ones above.
    expect(full.slice(-first.length)).toEqual(first);
  });

  it("does not grow while the reader has scrolled away", async () => {
    const items = chat(80);
    const view = setup();
    act(() => {
      view.result.current.startWarmMount();
      view.rerender({ list: items });
      view.result.current.stickToBottomRef.current = false;
      view.result.current.setFollowing(false);
    });
    for (let i = 0; i < 10; i++) await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(users(view.result.current.visibleItems)).toBe(WARM_FIRST_TURNS);
  });
});
