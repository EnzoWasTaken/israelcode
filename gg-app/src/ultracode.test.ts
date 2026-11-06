import { describe, expect, it } from "vitest";
import { hasUltracodeKeyword, parseUltracodeCommand } from "./ultracode";

describe("ultracode composer helpers", () => {
  it("arms on the word, not on look-alikes", () => {
    expect(hasUltracodeKeyword("ultracode: port the parser")).toBe(true);
    expect(hasUltracodeKeyword("do this, UltraCode")).toBe(true);
    expect(hasUltracodeKeyword("open ultracode-notes.md")).toBe(false);
    expect(hasUltracodeKeyword("ultracoder")).toBe(false);
  });

  it("parses /ultracode with an optional on/off", () => {
    expect(parseUltracodeCommand("/ultracode")).toBe("toggle");
    expect(parseUltracodeCommand(" /ultracode ON ")).toBe("on");
    expect(parseUltracodeCommand("/ultracode off")).toBe("off");
    expect(parseUltracodeCommand("/ultracode maybe")).toBeNull();
    expect(parseUltracodeCommand("ultracode")).toBeNull();
  });
});
