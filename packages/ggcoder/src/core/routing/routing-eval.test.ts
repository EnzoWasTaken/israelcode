import { describe, expect, it } from "vitest";
import type { DecisionAdapter, DecisionInput, RawRouteChoice } from "./decision-adapter.js";
import { routeTask } from "./router.js";
import { makeConfig, makeRegistry, makeRequest, realModel } from "./routing-fixtures.js";
import { extractSignals } from "./signals.js";
import type { ExecutionMode, RouteRequest } from "./types.js";

const REGISTRY = makeRegistry([
  realModel("claude-haiku-5-5"),
  realModel("claude-sonnet-5-5"),
  realModel("claude-opus-5-5"),
  realModel("gemini-3.1-flash-lite"),
]);
const NO_VIDEO_REGISTRY = makeRegistry([
  realModel("claude-haiku-5-5"),
  realModel("claude-sonnet-5-5"),
  realModel("gemini-3.1-flash-lite"),
]);

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at getUser (src/users.ts:42:13)
    at handler (src/api.ts:10:5)
the failing test is users.test.ts, why does this error happen?`;

interface Case {
  name: string;
  req: RouteRequest;
  /** Max acceptable difficulty-driven effort. */
  simple: boolean;
  modes: ExecutionMode[];
  vision?: boolean;
  video?: boolean;
  /** Model the scripted decider "chooses". */
  script: { model: string; difficulty: string; mode?: string; kind?: string };
}

const cases: Case[] = [
  {
    name: "greeting",
    req: makeRequest({ text: "hi" }),
    simple: true,
    modes: ["standard"],
    script: { model: "anthropic:claude-haiku-5-5", difficulty: "trivial", kind: "conversation" },
  },
  {
    name: "regex question",
    req: makeRequest({ text: "what does this regex do: ^\\d{3}-\\d{4}$" }),
    simple: true,
    modes: ["standard"],
    script: { model: "gemini:gemini-3.1-flash-lite", difficulty: "trivial", kind: "conversation" },
  },
  {
    name: "typo fix",
    req: makeRequest({ text: "fix the typo in the README title: 'Instalation'" }),
    simple: true,
    modes: ["standard"],
    script: { model: "anthropic:claude-haiku-5-5", difficulty: "trivial", kind: "coding" },
  },
  {
    name: "debug with stack trace",
    req: makeRequest({ text: STACK }),
    simple: false,
    modes: ["standard"],
    script: { model: "anthropic:claude-sonnet-5-5", difficulty: "moderate", kind: "debugging" },
  },
  {
    name: "big refactor",
    req: makeRequest({
      text: "refactor the auth module across the whole API and update all tests",
    }),
    simple: false,
    modes: ["ultracode", "orchestrate"],
    script: {
      model: "anthropic:claude-opus-5-5",
      difficulty: "hard",
      mode: "orchestrate",
      kind: "coding",
    },
  },
  {
    name: "plan a migration",
    req: makeRequest({ text: "plan a migration from REST to GraphQL" }),
    simple: false,
    modes: ["standard", "ultracode", "orchestrate"],
    script: { model: "anthropic:claude-opus-5-5", difficulty: "moderate", kind: "planning" },
  },
  {
    name: "screenshot UI bug",
    req: makeRequest({
      text: "the button looks wrong in this screenshot",
      attachments: [{ kind: "image", mime: "image/png" }],
    }),
    simple: false,
    modes: ["standard"],
    vision: true,
    script: { model: "anthropic:claude-sonnet-5-5", difficulty: "simple", kind: "vision" },
  },
  {
    name: "video attachment",
    req: makeRequest({
      text: "what happens in this clip?",
      attachments: [{ kind: "video", bytes: 5_000_000 }],
    }),
    simple: false,
    modes: ["standard"],
    video: true,
    script: { model: "gemini:gemini-3.1-flash-lite", difficulty: "simple", kind: "vision" },
  },
  {
    name: "research compare",
    req: makeRequest({ text: "compare Postgres and SQLite for a desktop app" }),
    simple: false,
    modes: ["standard"],
    script: { model: "anthropic:claude-sonnet-5-5", difficulty: "moderate", kind: "research" },
  },
  {
    name: "chat big task",
    req: makeRequest({
      text: "refactor the entire codebase across every module and migrate all the tests",
      workspace: "chat",
    }),
    simple: false,
    modes: ["standard"],
    script: { model: "anthropic:claude-opus-5-5", difficulty: "hard", kind: "coding" },
  },
  {
    name: "goal window",
    req: makeRequest({
      text: "refactor the entire codebase across every module and migrate all the tests",
      isGoal: true,
    }),
    simple: false,
    modes: ["standard"],
    script: { model: "anthropic:claude-opus-5-5", difficulty: "hard", kind: "coding" },
  },
  {
    name: "no spawn_agent",
    req: makeRequest({
      text: "refactor the entire codebase across every module and migrate all the tests",
      hasSpawnAgent: false,
    }),
    simple: false,
    modes: ["standard"],
    script: { model: "anthropic:claude-opus-5-5", difficulty: "hard", kind: "coding" },
  },
  {
    name: "decomposable but small",
    req: makeRequest({ text: "rename the variable foo to bar in utils.ts" }),
    simple: true,
    modes: ["standard"],
    script: { model: "anthropic:claude-haiku-5-5", difficulty: "simple", kind: "coding" },
  },
  {
    name: "short follow-up",
    req: makeRequest({ text: "yes, go ahead" }),
    simple: true,
    modes: ["standard"],
    script: { model: "anthropic:claude-sonnet-5-5", difficulty: "trivial", kind: "conversation" },
  },
  {
    name: "explain a function",
    req: makeRequest({ text: "explain what the debounce function in hooks.ts does" }),
    simple: true,
    modes: ["standard"],
    script: { model: "anthropic:claude-haiku-5-5", difficulty: "simple", kind: "coding" },
  },
];

const scripted = (c: Case): DecisionAdapter => ({
  id: "scripted",
  label: "scripted",
  async decide(input: DecisionInput): Promise<RawRouteChoice> {
    const mode = input.allowedModes.includes(c.script.mode as ExecutionMode)
      ? c.script.mode!
      : "standard";
    // A scripted decider that respects the offered candidates (like a real one must).
    const pick = input.candidates.find((x) => x.id === c.script.model) ?? input.candidates[0]!;
    return {
      model: pick.id,
      effort: c.script.difficulty === "hard" ? "high" : "low",
      executionMode: mode,
      taskKind: c.script.kind ?? "coding",
      difficulty: c.script.difficulty,
      confidence: 0.9,
    };
  },
});

const vision = (provider: string, model: string, reg = REGISTRY) =>
  reg.find((x) => x.provider === provider && x.model === model)!;

describe.each([
  ["deterministic fallback", () => null],
  ["scripted adapter", (c: Case) => scripted(c)],
] as const)("routing eval — %s", (_label, adapterFor) => {
  for (const c of cases) {
    it(c.name, async () => {
      const registry = c.video ? NO_VIDEO_REGISTRY.filter((m) => m.video) : REGISTRY;
      const d = await routeTask(c.req, {
        config: makeConfig(),
        registry,
        adapter: adapterFor(c),
      });
      const cap = vision(d.provider, d.model, registry);
      expect(cap, "selected model must be a connected candidate").toBeDefined();
      expect(c.modes).toContain(d.executionMode);
      if (c.vision) expect(cap.vision).toBe(true);
      if (c.video) expect(cap.video).toBe(true);
      if (c.simple) {
        expect(d.executionMode).toBe("standard");
        // Lowest rung the model supports (some models only offer higher rungs).
        expect(d.effort).toBe(cap.thinkingLevels.length ? cap.thinkingLevels[0] : null);
        expect(cap.relativeCost).toBeLessThanOrEqual(3);
      }
      expect(d.explanation.length).toBeGreaterThan(0);
    });
  }
});

describe("routing eval — deterministic specifics", () => {
  const route = (req: RouteRequest, registry = REGISTRY) =>
    routeTask(req, { config: makeConfig(), registry, adapter: null });

  it("signals classify the representative tasks", () => {
    expect(extractSignals(makeRequest({ text: "hi" })).taskKind).toBe("conversation");
    expect(extractSignals(makeRequest({ text: STACK })).taskKind).toBe("debugging");
    expect(extractSignals(makeRequest({ text: "plan a migration" })).taskKind).toBe("planning");
    expect(extractSignals(makeRequest({ text: "compare A and B" })).taskKind).toBe("research");
    const big = extractSignals(
      makeRequest({ text: "refactor the auth module across the whole API and update all tests" }),
    );
    expect(big.difficulty).toBe("hard");
    expect(extractSignals(makeRequest({ text: "ok continue" })).isFollowUp).toBe(true);
    expect(extractSignals(makeRequest({ text: "use ultracode for this" })).explicitUltracode).toBe(
      true,
    );
    expect(extractSignals(makeRequest({ text: "orchestrate it" })).explicitOrchestrate).toBe(true);
    const shot = extractSignals(
      makeRequest({ text: "see ![x](a.png)", attachments: [{ kind: "document" }] }),
    );
    expect(shot.needsImage).toBe(true);
  });

  it("hard work picks the strongest model, simple work a cheap one", async () => {
    const hard = await route(
      makeRequest({ text: "refactor the auth module across the whole API and update all tests" }),
    );
    expect(hard.model).toBe("claude-opus-5-5");
    expect(hard.executionMode).toBe("ultracode");
    const easy = await route(
      makeRequest({
        text: "hi",
        current: {
          provider: "anthropic",
          model: "claude-opus-5-5",
          thinkingLevel: "high",
          executionMode: "standard",
        },
      }),
    );
    expect(["claude-haiku-5-5", "gemini-3.1-flash-lite"]).toContain(easy.model);
  });

  it("prefers the current model when it qualifies (prompt-cache affinity)", async () => {
    const d = await route(makeRequest({ text: STACK }));
    expect(d.model).toBe("claude-sonnet-5-5");
    expect(d.reason).toBe("kept_current");
  });

  it("an image task with no vision model is a constraint violation", async () => {
    const d = await route(
      makeRequest({ text: "bug in screenshot", attachments: [{ kind: "image" }] }),
      REGISTRY.filter(() => false),
    );
    expect(d.fallbackReason).toBe("constraint_violation");
    expect(d.model).toBe("claude-sonnet-5-5");
  });

  it("honours maxEffort", async () => {
    const d = await routeTask(
      makeRequest({ text: "refactor the auth module across the whole API and update all tests" }),
      { config: makeConfig({ maxEffort: "low" }), registry: REGISTRY, adapter: null },
    );
    expect(d.effort).toBe("low");
  });
});
