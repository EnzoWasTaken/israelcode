import { describe, expect, it, vi } from "vitest";
import { createApprovalBridge } from "./approvals.js";

function bridge(allowed: string[] = []) {
  const broadcast = vi.fn();
  const rememberAlways = vi.fn(async (command: string) => {
    allowed.push(command);
  });
  const b = createApprovalBridge({
    broadcast,
    isAlwaysAllowed: async (command) => allowed.includes(command),
    rememberAlways,
  });
  return { b, broadcast, rememberAlways };
}

describe("approval bridge", () => {
  it("holds a call until the user answers, then clears the card", async () => {
    const { b, broadcast } = bridge();
    const answer = b.request({ tool: "edit", paths: ["a.ts"] }, new AbortController().signal);
    const [card] = b.list();
    expect(broadcast).toHaveBeenCalledWith(
      "approval_request",
      expect.objectContaining({ id: card!.id, tool: "edit" }),
    );
    expect(await b.answer(card!.id, { decision: "deny", note: "not that file" })).toBe(true);
    expect(await answer).toEqual({ decision: "deny", note: "not that file" });
    expect(b.list()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith("approval_resolved", { id: card!.id, decision: "deny" });
    expect(await b.answer(card!.id, { decision: "allow" })).toBe(false);
  });

  it("remembers an always-allowed command and skips the card next time", async () => {
    const { b, rememberAlways } = bridge();
    const first = b.request({ tool: "bash", command: "pnpm test" }, new AbortController().signal);
    // The allow-list check is async; the card appears once it says no.
    await vi.waitFor(() => expect(b.list()).toHaveLength(1));
    await b.answer(b.list()[0]!.id, { decision: "always" });
    expect(await first).toEqual({ decision: "always" });
    expect(rememberAlways).toHaveBeenCalledWith("pnpm test");
    expect(
      await b.request({ tool: "bash", command: "pnpm test" }, new AbortController().signal),
    ).toEqual({
      decision: "allow",
    });
    expect(b.list()).toEqual([]);
  });

  it("denies a waiting call when the run stops", async () => {
    const { b } = bridge();
    const controller = new AbortController();
    const answer = b.request({ tool: "bash", command: "rm -rf dist" }, controller.signal);
    controller.abort();
    expect(await answer).toMatchObject({ decision: "deny" });
    expect(b.list()).toEqual([]);
  });
});
