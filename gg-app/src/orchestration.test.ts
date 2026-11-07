import { describe, expect, it } from "vitest";
import { hasOrchestrateKeyword } from "./orchestration";

describe("orchestrate composer helper", () => {
  it("arms on the word, not on look-alikes", () => {
    expect(hasOrchestrateKeyword("orchestrate: port the parser")).toBe(true);
    expect(hasOrchestrateKeyword("do this, Orchestrate")).toBe(true);
    expect(hasOrchestrateKeyword("open orchestrate-notes.md")).toBe(false);
    expect(hasOrchestrateKeyword("orchestrated")).toBe(false);
    expect(hasOrchestrateKeyword("orchestration")).toBe(false);
  });
});
