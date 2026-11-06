import { beforeEach, describe, expect, it } from "vitest";
import { FUN_OUTCOME_PHRASES, OUTCOME_PHRASES, outcomePhrase } from "./activity-copy";
import { setFlavorEnabled } from "./flavor";

function checkPool(label: string, phrases: readonly string[], fun: boolean): void {
  setFlavorEnabled(fun);
  expect(new Set(phrases).size).toBeGreaterThanOrEqual(6);
  for (const phrase of phrases) {
    expect(phrase.length).toBeGreaterThanOrEqual(12);
    expect(phrase.length).toBeLessThanOrEqual(26);
    expect(phrase).not.toMatch(/[\n\r]|shipped|production.ready|all done|everything passed/i);
  }
  expect(
    Math.max(...phrases.map((p) => p.length)) - Math.min(...phrases.map((p) => p.length)),
  ).toBeLessThanOrEqual(10);
  for (let seed = 0; seed < phrases.length; seed++) {
    expect(outcomePhrase(label, seed)).toBe(phrases[seed]);
    expect(outcomePhrase(label, seed)).toBe(outcomePhrase(label, seed));
  }
}

describe("Israel Code outcome wording", () => {
  beforeEach(() => setFlavorEnabled(true));

  it.each(Object.entries(OUTCOME_PHRASES))(
    "keeps %s concise, varied and stable with humour off",
    (label, phrases) => checkPool(label, phrases, false),
  );
  it.each(Object.entries(FUN_OUTCOME_PHRASES))(
    "keeps the funny %s just as concise, varied and stable",
    (label, phrases) => {
      expect(OUTCOME_PHRASES[label], "fun pool for an outcome that exists").toBeDefined();
      checkPool(label, phrases, true);
    },
  );
  it("keeps prompts for the user plain, even with humour on", () => {
    for (const label of ["Your decision needed", "Plan needs your decision"]) {
      expect(FUN_OUTCOME_PHRASES[label]).toBeUndefined();
      expect(outcomePhrase(label, 0)).toBe(OUTCOME_PHRASES[label]![0]);
    }
  });
  it("leaves event labels outside the outcome pools alone", () => {
    expect(outcomePhrase("Retrying…", 42)).toBeUndefined();
    expect(outcomePhrase("Working…", 42)).toBeUndefined();
  });
  it("never substitutes green language for failure or missing verification", () => {
    for (const label of [
      "Checks failed",
      "Verification incomplete",
      "Task failed",
      "Israel’s review failed",
    ]) {
      for (const phrase of [...OUTCOME_PHRASES[label]!, ...(FUN_OUTCOME_PHRASES[label] ?? [])])
        expect(phrase).not.toMatch(/passed|green|ready|success/i);
    }
  });
});
