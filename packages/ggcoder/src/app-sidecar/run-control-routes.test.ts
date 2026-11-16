import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../core/thinking-level.js";
import { resolveThinkingRequest } from "./run-control-routes.js";

// Claude Sonnet 5.5 cycles low → medium → high → xhigh → off.
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-5-5";

describe("resolveThinkingRequest", () => {
  it("cycles to the next level when the body is empty", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "medium", "")).toEqual({
      ok: true,
      level: "high",
    });
  });

  it("jumps straight to a requested level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", '{"level":"xhigh"}')).toEqual({
      ok: true,
      level: "xhigh",
    });
  });

  it("turns thinking off for a null level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "high", '{"level":null}')).toEqual({
      ok: true,
      level: undefined,
    });
  });

  it("refuses a level the model doesn't support", () => {
    const result = resolveThinkingRequest(PROVIDER, "claude-sonnet-5", "low", '{"level":"xhigh"}');
    expect(result.ok).toBe(false);
  });

  it("refuses malformed JSON", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", "{nope").ok).toBe(false);
  });
});

describe("resolveThinkingRequest ultra", () => {
  it("API-key OpenAI refuses ultra; clamp keeps the nearest rung", () => {
    const r = resolveThinkingRequest("openai", "gpt-6-astra", "high", '{"level":"ultra"}');
    expect(r.ok).toBe(false);
  });
});

describe("model switch thinking clamp", () => {
  it("xhigh moving to a model without xhigh keeps the nearest rung, not off or the first", () => {
    const supported = getSupportedThinkingLevels("anthropic", "claude-sonnet-5", {
      provider: "anthropic",
    });
    expect(supported).not.toContain("xhigh");
    expect(
      clampThinkingLevel("anthropic", "claude-sonnet-5", "xhigh", { provider: "anthropic" }),
    ).toBe("high");
  });

  it("ChatGPT sign-in (accountId) keeps ultra for gpt-6-astra; an API key does not", () => {
    const chatgpt = getSupportedThinkingLevels("openai", "gpt-6-astra", {
      provider: "openai",
      accountId: "acct_1",
    });
    const apiKey = getSupportedThinkingLevels("openai", "gpt-6-astra", { provider: "openai" });
    expect(chatgpt).toContain("ultra");
    expect(apiKey).not.toContain("ultra");
  });
});
