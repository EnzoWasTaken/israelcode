// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SubAgentLine } from "./SubAgentFeed";
import type { Item as TranscriptItem } from "./transcript-item";
import { ultracodePhases, ultracodeTurns } from "./ultracode-phases";
import { UltracodePhases } from "./UltracodePhases";

afterEach(cleanup);

const agent = (agentName: string, status: SubAgentLine["status"]): SubAgentLine => ({
  toolCallId: agentName,
  agentName,
  status,
  activities: [],
  toolUseCount: 0,
});
const group = (id: number, agents: SubAgentLine[]): TranscriptItem => ({
  kind: "subagent_group",
  id,
  agents,
});
const todos: TranscriptItem = { kind: "todos", id: 2, todos: [] };
const statuses = (phases: ReturnType<typeof ultracodePhases>) =>
  phases?.map((p) => `${p.id}:${p.status}`);

describe("ultracodePhases", () => {
  it("starts in planning", () => {
    expect(statuses(ultracodePhases([], true))).toEqual([
      "plan:active",
      "build:pending",
      "review:pending",
      "combine:pending",
    ]);
  });

  it("follows the build, then the reviewer, then combining", () => {
    const building = [todos, group(3, [agent("api", "running"), agent("ui", "done")])];
    const phases = ultracodePhases(building, true);
    expect(statuses(phases)).toEqual([
      "plan:done",
      "build:active",
      "review:pending",
      "combine:pending",
    ]);
    expect(phases?.[1]?.detail).toBe("2 agents, 1/2 done");

    const reviewing = [
      todos,
      group(3, [agent("api", "done"), agent("ui", "error")]),
      group(4, [agent("review diff", "running")]),
    ];
    expect(statuses(ultracodePhases(reviewing, true))?.slice(1)).toEqual([
      "build:done",
      "review:active",
      "combine:pending",
    ]);
    expect(ultracodePhases(reviewing, true)?.[1]?.detail).toBe("2 agents, 2/2 done, 1 failed");

    const combining = [...reviewing.slice(0, 2), group(4, [agent("review diff", "done")])];
    expect(statuses(ultracodePhases(combining, true))?.[3]).toBe("combine:active");
    expect(statuses(ultracodePhases(combining, false))?.[3]).toBe("combine:done");
  });

  it("drops the strip for a small job handled directly", () => {
    expect(ultracodePhases([todos], false)).toBeNull();
  });
});

describe("ultracodeTurns", () => {
  it("collects the rows after each Ultracode message, up to the next message", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: 1, text: "big", ultracode: true },
      todos,
      { kind: "user", id: 5, text: "steer", queued: true },
      { kind: "user", id: 6, text: "small" },
      group(7, []),
    ];
    const turns = ultracodeTurns(items);
    expect([...turns.keys()]).toEqual([1]);
    expect(turns.get(1)?.map((it) => it.id)).toEqual([2, 5]);
  });

  it("gives an Orchestrate turn the same strip as an Ultracode one", () => {
    const rows = [todos, group(3, [agent("api", "running")])];
    const tail: TranscriptItem[] = [{ kind: "user", id: 6, text: "small" }, group(7, [])];
    const orchestrated = ultracodeTurns([
      { kind: "user", id: 1, text: "big", orchestrate: true },
      ...rows,
      ...tail,
    ]);
    const ultra = ultracodeTurns([
      { kind: "user", id: 1, text: "big", ultracode: true },
      ...rows,
      ...tail,
    ]);
    expect([...orchestrated.keys()]).toEqual([1]);
    expect(orchestrated.get(1)).toEqual(ultra.get(1));
    expect(statuses(ultracodePhases(orchestrated.get(1)!, true))).toEqual(
      statuses(ultracodePhases(ultra.get(1)!, true)),
    );
    expect(statuses(ultracodePhases(orchestrated.get(1)!, true))?.[1]).toBe("build:active");
  });
});

describe("UltracodePhases", () => {
  it("lists each phase with its state for screen readers", () => {
    render(
      <UltracodePhases
        phases={ultracodePhases([todos, group(3, [agent("a", "running")])], true)!}
      />,
    );
    const list = screen.getByRole("list", { name: "Ultracode phases" });
    expect(list.textContent).toContain("Build1 agent, 0/1 done, in progress");
  });
});
