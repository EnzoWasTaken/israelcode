import type { StreamResponse } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { buildDecisionInput, DecisionError, type DecisionInput } from "./decision-adapter.js";
import { createDecisionsApiAdapter } from "./decisions-api-adapter.js";
import { resolveConstraints } from "./constraints.js";
import { createLlmDecisionAdapter } from "./llm-adapter.js";
import { makeConfig, makeRegistry, makeRequest } from "./routing-fixtures.js";
import { extractSignals } from "./signals.js";

const KEY = "sk-or-FAKESECRETKEY1234567890";
const mkInput = (text = "hello", over = {}): DecisionInput => {
  const req = makeRequest({ text, ...over });
  const signals = extractSignals(req);
  const cons = resolveConstraints(req, signals, makeConfig(), makeRegistry());
  return buildDecisionInput(req, signals, cons);
};
const sig = () => new AbortController().signal;
const json = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const okBody = {
  model: "x",
  answers: {
    model: {
      type: "choice",
      choice: "anthropic:claude-haiku-5-5",
      confidence: 0.9,
      probabilities: {},
    },
    mode: { type: "choice", choice: "standard", confidence: 0.8, probabilities: {} },
    difficulty: { type: "score", score: 0.6, confidence: 0.7, probabilities: {}, legend: [] },
    task_kind: { type: "choice", choice: "conversation", confidence: 0.95, probabilities: {} },
  },
  usage: { input_tokens: 100, output_tokens: 5, cost: 0.0001 },
};

const callOf = (f: ReturnType<typeof json>) => f.mock.calls[0] as unknown as [string, RequestInit];

describe("decisions API adapter", () => {
  it("sends the documented request shape with only valid candidates", async () => {
    const f = json(200, okBody);
    const adapter = createDecisionsApiAdapter({
      service: "openrouter",
      apiKey: KEY,
      fetch: f as never,
    });
    const input = mkInput("hello", { workspace: "chat" });
    await adapter.decide(input, sig());
    const [url, init] = callOf(f);
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("typesafe/jev-1.14");
    expect(Object.keys(body.questions.model.criteria).sort()).toEqual(
      input.candidates.map((c) => c.id).sort(),
    );
    expect(body.questions.mode).toBeUndefined(); // chat: only standard allowed
    expect(body.questions.difficulty).toMatchObject({ type: "score" });
    expect(body.questions.difficulty.criteria).toHaveLength(4);
  });

  it("asks for mode only among allowed modes and parses the answers", async () => {
    const f = json(200, okBody);
    const adapter = createDecisionsApiAdapter({
      service: "typesafe",
      apiKey: KEY,
      fetch: f as never,
    });
    const raw = await adapter.decide(mkInput(), sig());
    const body = JSON.parse(callOf(f)[1].body as string);
    expect(Object.keys(body.questions.mode.criteria)).toEqual([
      "standard",
      "ultracode",
      "orchestrate",
    ]);
    expect(body.model).toBe("jev-latest");
    expect(raw).toMatchObject({
      model: "anthropic:claude-haiku-5-5",
      difficulty: "simple",
      effort: "low",
      confidence: 0.7,
      usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.0001 },
    });
  });

  it.each([
    [401, "missing_credentials"],
    [403, "missing_credentials"],
    [429, "rate_limited"],
    [402, "provider_error"],
    [503, "provider_error"],
  ])("maps HTTP %i → %s without leaking the key", async (status, reason) => {
    const adapter = createDecisionsApiAdapter({
      service: "openrouter",
      apiKey: KEY,
      fetch: json(status, { error: { code: status, message: `bad ${KEY}` } }) as never,
    });
    const err = await adapter.decide(mkInput(), sig()).catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.reason).toBe(reason);
    expect(JSON.stringify(err) + err.message + err.stack).not.toContain(KEY);
  });

  it("treats refusals and bad shapes as invalid_output", async () => {
    for (const body of [
      { ...okBody, answers: { ...okBody.answers, model: { type: "refusal" } } },
      { answers: "nope" },
      { ...okBody, answers: { ...okBody.answers, difficulty: { type: "choice", choice: "x" } } },
    ]) {
      const adapter = createDecisionsApiAdapter({
        service: "openrouter",
        apiKey: KEY,
        fetch: json(200, body) as never,
      });
      await expect(adapter.decide(mkInput(), sig())).rejects.toMatchObject({
        reason: "invalid_output",
      });
    }
  });

  it("maps network errors without leaking and aborts to timeout", async () => {
    const boom = vi.fn(async () => {
      throw new Error(`connect failed Bearer ${KEY}`);
    });
    const a = createDecisionsApiAdapter({
      service: "openrouter",
      apiKey: KEY,
      fetch: boom as never,
    });
    const err = await a.decide(mkInput(), sig()).catch((e) => e);
    expect(err.reason).toBe("provider_error");
    expect(err.message).not.toContain(KEY);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(a.decide(mkInput(), ctrl.signal)).rejects.toMatchObject({ reason: "timeout" });
  });

  it("truncates and redacts task text", () => {
    const input = mkInput(`${"a".repeat(9000)} ${KEY}`);
    expect(input.taskText.length).toBeLessThanOrEqual(4100);
    expect(input.taskText).not.toContain(KEY);
    const short = mkInput(`use ${KEY} please`);
    expect(short.taskText).not.toContain(KEY);
  });
});

describe("LLM decision adapter", () => {
  const response = (content: unknown): StreamResponse =>
    ({
      message: { role: "assistant", content },
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 10 },
    }) as StreamResponse;
  const call = (args: unknown) => [{ type: "tool_call", id: "1", name: "select_route", args }];

  it("forces select_route and validates the tool call", async () => {
    const streamFn = vi.fn((_o: unknown) => ({
      response: Promise.resolve(
        response(
          call({
            model: "anthropic:claude-haiku-5-5",
            effort: "low",
            executionMode: "standard",
            taskKind: "conversation",
            difficulty: "trivial",
            confidence: 0.9,
          }),
        ),
      ),
    }));
    const adapter = createLlmDecisionAdapter({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      credentials: { apiKey: KEY },
      streamFn: streamFn as never,
    });
    const raw = await adapter.decide(mkInput(), sig());
    expect(raw).toMatchObject({ model: "anthropic:claude-haiku-5-5", usage: { inputTokens: 50 } });
    const opts = streamFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.toolChoice).toEqual({ name: "select_route" });
    expect(opts.thinking).toBeUndefined();
    expect(opts.maxTokens as number).toBeLessThanOrEqual(500);
    expect(opts.apiKey).toBe(KEY);
  });

  it("rejects text-only, malformed or out-of-candidate output", async () => {
    for (const content of [
      "just some text",
      [{ type: "text", text: "hi" }],
      call({ model: "evil:model" }),
    ]) {
      const adapter = createLlmDecisionAdapter({
        provider: "anthropic",
        model: "m",
        credentials: {},
        streamFn: (() => ({ response: Promise.resolve(response(content)) })) as never,
      });
      await expect(adapter.decide(mkInput(), sig())).rejects.toMatchObject({
        reason: "invalid_output",
      });
    }
  });

  it("maps provider failures to reasons without echoing the message", async () => {
    const mk = (err: unknown) =>
      createLlmDecisionAdapter({
        provider: "anthropic",
        model: "m",
        credentials: { apiKey: KEY },
        streamFn: (() => ({ response: Promise.reject(err) })) as never,
      });
    const e1 = await mk(Object.assign(new Error(`429 ${KEY}`), { status: 429 }))
      .decide(mkInput(), sig())
      .catch((e) => e);
    expect(e1.reason).toBe("rate_limited");
    expect(e1.message).not.toContain(KEY);
    await expect(mk(new Error("401 Unauthorized")).decide(mkInput(), sig())).rejects.toMatchObject({
      reason: "missing_credentials",
    });
    await expect(mk(new Error("dns")).decide(mkInput(), sig())).rejects.toMatchObject({
      reason: "provider_error",
    });
  });
});

describe("Claude Fable 5.2 in the routing registry", () => {
  it("is a reasoning model with the full effort ladder, so effort picks scale with difficulty", async () => {
    const { buildCapabilityRegistry } = await import("./capabilities.js");
    const { effortForDifficulty } = await import("./decision-adapter.js");
    const { getModel } = await import("../model-registry.js");
    const info = getModel("claude-fable-5-2");
    expect(info).toBeTruthy();
    const [cap] = buildCapabilityRegistry({ models: [info!], isAvailable: () => true });
    expect(cap!.strengths).toContain("reasoning");
    expect(cap!.thinkingLevels).toEqual(["low", "medium", "high", "max"]);
    expect(effortForDifficulty("trivial", cap!.thinkingLevels)).toBe("low");
    expect(effortForDifficulty("moderate", cap!.thinkingLevels)).toBe("medium");
    expect(effortForDifficulty("hard", cap!.thinkingLevels)).toBe("high");
  });
});
