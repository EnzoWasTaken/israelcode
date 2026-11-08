// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  queueFirstPrompt,
  takeFirstPrompt,
  useFirstPrompt,
  type HydrateSettled,
} from "./first-prompt";

afterEach(() => void takeFirstPrompt());

describe("useFirstPrompt", () => {
  it("sends the queued prompt exactly once, after the session is ready", () => {
    queueFirstPrompt("build it");
    const send = vi.fn(() => true);
    const restore = vi.fn();
    const { rerender } = renderHook(
      ({ settled }: { settled: HydrateSettled | null }) => useFirstPrompt(settled, send, restore),
      { initialProps: { settled: null as HydrateSettled | null } },
    );
    expect(send).not.toHaveBeenCalled();
    const ready = { ok: true };
    rerender({ settled: ready });
    rerender({ settled: ready });
    rerender({ settled: { ok: true } });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("build it");
    expect(restore).not.toHaveBeenCalled();
  });

  it("puts the text back in the composer when the session didn't start", () => {
    queueFirstPrompt("keep me");
    const send = vi.fn(() => true);
    const restore = vi.fn();
    renderHook(() => useFirstPrompt({ ok: false }, send, restore));
    expect(send).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith("keep me");
  });

  it("puts the text back when the send is refused", () => {
    queueFirstPrompt("refused");
    const restore = vi.fn();
    renderHook(() => useFirstPrompt({ ok: true }, () => false, restore));
    expect(restore).toHaveBeenCalledWith("refused");
  });

  it("does nothing without a queued prompt", () => {
    queueFirstPrompt("   ");
    const send = vi.fn(() => true);
    renderHook(() => useFirstPrompt({ ok: true }, send, vi.fn()));
    expect(send).not.toHaveBeenCalled();
  });
});
