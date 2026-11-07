// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CRITTERS, renderCritterFrame } from "./critter-sprites";
import {
  CRITTER_LINES,
  formatSubAgentTokens,
  SubAgentFeed,
  summarizeCritters,
  workerModelNote,
  type SubAgentLine,
} from "./SubAgentFeed";

describe("formatSubAgentTokens", () => {
  it("adds Anthropic cache writes to fresh input for provider-neutral usage", () => {
    expect(
      formatSubAgentTokens({ input: 2, output: 500, cacheRead: 80_000, cacheWrite: 12_000 }),
    ).toBe("↑ 12.0k · ↻ 80k cached · ↓ 500");
  });

  it("keeps OpenAI non-cached input unchanged", () => {
    expect(formatSubAgentTokens({ input: 50_000, output: 800, cacheRead: 65_000 })).toBe(
      "↑ 50k · ↻ 65k cached · ↓ 800",
    );
  });
});

let nextCall = 0;
function agent(status: SubAgentLine["status"], toolCallId = `call-${nextCall++}`): SubAgentLine {
  return {
    toolCallId,
    agentName: "researcher",
    status,
    activities: [],
    toolUseCount: 3,
    tokenUsage: { input: 0, output: 0 },
    durationMs: 9000,
  };
}

/** Every phrasing a line could take, with `{n}` filled in. */
function variants(lines: { one: readonly string[]; many: readonly string[] }, n: number): string[] {
  return (n === 1 ? lines.one : lines.many).map((line) => line.replace("{n}", String(n)));
}

describe("CRITTER_LINES", () => {
  it("has five distinct phrasings for every outcome, singular and plural", () => {
    for (const lines of Object.values(CRITTER_LINES)) {
      for (const list of [lines.one, lines.many]) {
        expect(list).toHaveLength(5);
        expect(new Set(list).size).toBe(5);
      }
    }
  });

  it("keeps lines simple: no agent names, durations or follow-up notes", () => {
    const all = Object.values(CRITTER_LINES).flatMap((lines) => [...lines.one, ...lines.many]);
    for (const line of all) expect(line).not.toMatch(/researcher|\d+s\b|·|follow-up/);
  });
});

describe("summarizeCritters", () => {
  it.each([
    ["one running", [agent("running")], false, CRITTER_LINES.launched, 1, "working"],
    [
      "two starting",
      [agent("starting"), agent("running")],
      false,
      CRITTER_LINES.launched,
      2,
      "working",
    ],
    // Counts only the ones still out: 2 of 4 finished reads "2 critters", not "4".
    [
      "two of four finished",
      [agent("running"), agent("done"), agent("running"), agent("idle")],
      false,
      CRITTER_LINES.stillWorking,
      2,
      "working",
    ],
    [
      "one still running",
      [agent("running"), agent("done")],
      false,
      CRITTER_LINES.stillWorking,
      1,
      "working",
    ],
    ["one done", [agent("done")], false, CRITTER_LINES.succeeded, 1, "done"],
    ["done and idle", [agent("done"), agent("idle")], false, CRITTER_LINES.succeeded, 2, "done"],
    ["one failed", [agent("error")], false, CRITTER_LINES.failed, 1, "failed"],
    [
      "all failed",
      [agent("error"), agent("interrupted")],
      false,
      CRITTER_LINES.failed,
      2,
      "failed",
    ],
    ["some failed", [agent("idle"), agent("error")], false, CRITTER_LINES.someFailed, 1, "failed"],
    [
      "two of three failed",
      [agent("done"), agent("error"), agent("error")],
      false,
      CRITTER_LINES.someFailed,
      2,
      "failed",
    ],
    ["stopped", [agent("running"), agent("running")], true, CRITTER_LINES.calledBack, 2, "stopped"],
  ] as const)("%s", (_name, agents, aborted, lines, n, tone) => {
    const summary = summarizeCritters(agents, aborted);
    expect(summary.tone).toBe(tone);
    expect(variants(lines, n)).toContain(summary.text);
  });

  it("keeps the same wording for the same group on every render", () => {
    const group = [agent("done", "call-stable"), agent("done")];
    expect(summarizeCritters(group).text).toBe(summarizeCritters([...group]).text);
  });

  it("varies the wording across groups, reaching all five phrasings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(summarizeCritters([agent("error", `run-${i}`)]).text);
    expect([...seen].sort()).toEqual(variants(CRITTER_LINES.failed, 1).sort());
  });
});

describe("SubAgentFeed", () => {
  const img = (container: HTMLElement): HTMLImageElement => {
    const el = container.querySelector<HTMLImageElement>(".subagents-critter-img");
    if (!el) throw new Error("critter missing");
    return el;
  };
  const beeSprite = (): string => {
    const bee = CRITTERS.find((c) => c.id === "bee");
    if (!bee) throw new Error("bee missing");
    return renderCritterFrame(bee, 0);
  };

  it("leads the line with the agent's own critter instead of a dot", () => {
    const bee = { ...agent("running"), agentName: "bee" };
    const { container } = render(<SubAgentFeed agents={[bee]} />);
    expect(img(container).getAttribute("src")).toBe(beeSprite());
    expect(img(container).classList.contains("subagents-critter-working")).toBe(true);
    expect(container.textContent).not.toContain("\u23FA");
  });

  it("tips the critter over when the agents failed", () => {
    const { container } = render(<SubAgentFeed agents={[agent("error")]} />);
    expect(img(container).classList.contains("subagents-critter-failed")).toBe(true);
  });

  it("renders nothing for an empty group", () => {
    const { container } = render(<SubAgentFeed agents={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the Worker model when it differs from the main model", () => {
    const worker = { ...agent("done"), model: "gpt-6-luna" };
    const { container } = render(<SubAgentFeed agents={[worker]} mainModel="claude-opus-5-5" />);
    expect(container.textContent).toContain("(on gpt-6-luna)");
  });

  it("stays quiet when the worker runs on the main model or none was reported", () => {
    const same = { ...agent("done"), model: "claude-opus-5-5" };
    const { container } = render(<SubAgentFeed agents={[same]} mainModel="claude-opus-5-5" />);
    expect(container.textContent).not.toContain("(on ");
    cleanup();
    const unnamed = render(<SubAgentFeed agents={[agent("done")]} mainModel="claude-opus-5-5" />);
    expect(unnamed.container.textContent).not.toContain("(on ");
  });
});

describe("workerModelNote", () => {
  it("lists each distinct other model once, by display name when known", () => {
    const models = [{ id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" }];
    const agents = [
      { ...agent("done"), model: "gpt-6-luna" },
      { ...agent("done"), model: "gpt-6-luna" },
      { ...agent("done"), model: "claude-opus-5-5" },
    ];
    expect(workerModelNote(agents, "claude-opus-5-5", models)).toBe("on GPT-6 Luna");
    expect(workerModelNote(agents, "gpt-6-luna", models)).toBe("on claude-opus-5-5");
    expect(workerModelNote([agent("done")], "claude-opus-5-5")).toBeNull();
  });
});
