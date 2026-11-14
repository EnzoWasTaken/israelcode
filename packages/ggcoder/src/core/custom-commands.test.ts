import { describe, expect, it } from "vitest";
import { skillCommands } from "./custom-commands.js";
import type { Skill } from "./skills.js";

const skill = (over: Partial<Skill>): Skill => ({
  name: "a",
  description: "desc",
  content: "body",
  source: "global",
  ...over,
});

describe("skillCommands", () => {
  it("skips hidden skills, taken names and duplicates", () => {
    const result = skillCommands(
      [
        skill({ name: "a", root: "/r" }),
        skill({ name: "a" }),
        skill({ name: "h", hidden: true }),
        skill({ name: "t" }),
        skill({ name: "n", description: "" }),
      ],
      [{ name: "t", description: "", prompt: "p", filePath: "f" }],
    );
    expect(result.map((c) => c.name)).toEqual(["a", "n"]);
    expect(result[0]).toMatchObject({ description: "desc", filePath: "/r", source: "skill" });
    expect(result[0].prompt).toContain('"a"');
    expect(result[0].prompt).not.toContain("body");
    expect(result[1]).toMatchObject({ description: "Skill", filePath: "" });
  });
});
