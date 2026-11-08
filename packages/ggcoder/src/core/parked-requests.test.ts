import { afterEach, describe, expect, it, vi } from "vitest";
import { createParkedRequests } from "./parked-requests.js";

afterEach(() => vi.useRealTimers());

describe("parked requests suspension", () => {
  it("re-arms the timeout while suspended, then fires", async () => {
    vi.useFakeTimers();
    let suspended = true;
    const timedOut = vi.fn();
    const parked = createParkedRequests<{ q: string }, string>({
      idPrefix: "t",
      broadcast: () => {},
      cancelValue: () => "cancel",
      timeoutMs: 100,
      onTimeout: timedOut,
      isSuspended: () => suspended,
    });
    const result = parked.park({ q: "x" });
    await vi.advanceTimersByTimeAsync(350);
    expect(parked.pendingCount).toBe(1);
    expect(timedOut).not.toHaveBeenCalled();
    suspended = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe("cancel");
    expect(timedOut).toHaveBeenCalledOnce();
  });
});
