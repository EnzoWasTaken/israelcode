import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  buildUltracodeMessage,
  hasUltracodeKeyword,
  lastUltracodeState,
  ULTRACODE_ACTIVE_LIMIT,
} from "./ultracode.js";

describe("ultracode", () => {
  it("spots the keyword as a word, in any case", () => {
    expect(hasUltracodeKeyword("ultracode: rewrite the parser")).toBe(true);
    expect(hasUltracodeKeyword("Please UltraCode this")).toBe(true);
    expect(hasUltracodeKeyword("rename ultracode-mode.ts")).toBe(false);
    expect(hasUltracodeKeyword("ultracoder")).toBe(false);
  });

  it("names only the tools the session has", () => {
    const wide = buildUltracodeMessage(true, ["spawn_agent", "todo_write"]).content as string;
    expect(wide).toContain("`spawn_agent`");
    expect(wide).toContain(`up to ${ULTRACODE_ACTIVE_LIMIT} running at once`);
    expect(wide).toContain("`todo_write`");
    const solo = buildUltracodeMessage(true, ["read"]).content as string;
    expect(solo).not.toContain("spawn_agent");
    expect(solo).not.toContain("todo_write");
  });

  it("reads the newest notice in a history, defaulting to off", () => {
    const on = buildUltracodeMessage(true, []);
    const off = buildUltracodeMessage(false, []);
    const user: Message = { role: "user", content: "hi" };
    expect(lastUltracodeState([user])).toBe(false);
    expect(lastUltracodeState([on, user])).toBe(true);
    expect(lastUltracodeState([on, user, off])).toBe(false);
  });
});
