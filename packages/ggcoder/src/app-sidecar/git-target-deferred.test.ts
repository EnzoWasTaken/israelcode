import { describe, expect, it } from "vitest";

import { settleDeferredGit, type DeferredGitView } from "./git-target.js";

const view = (over: Partial<DeferredGitView> = {}): DeferredGitView => ({
  gitCwd: "/work/site",
  stopped: false,
  dirtyCountKnown: false,
  dirtyFileCount: 0,
  worktreeOf: null,
  ...over,
});

const reads = (dirty: number | Error, worktreeOf: string | null = null) => ({
  dirtyCount: async () => {
    if (dirty instanceof Error) throw dirty;
    return dirty;
  },
  worktreeOf: async () => worktreeOf,
});

describe("settleDeferredGit", () => {
  it("fills in the dirty count startup skipped", async () => {
    const result = await settleDeferredGit("/work/site", reads(7), () => view());
    expect(result).toEqual({
      update: { dirtyFileCount: 7, worktreeOf: null },
      dirtyFailed: false,
    });
  });

  it("never overwrites a count a poll or run already delivered", async () => {
    const result = await settleDeferredGit("/work/site", reads(7, "/work/main"), () =>
      view({ dirtyCountKnown: true, dirtyFileCount: 3 }),
    );
    expect(result.update).toEqual({ worktreeOf: "/work/main" });
  });

  it("drops the count when git was retargeted meanwhile", async () => {
    const result = await settleDeferredGit("/work/site", reads(7), () =>
      view({ gitCwd: "/work/engine" }),
    );
    expect(result.update).toBeNull();
  });

  it("reports nothing to change and nothing after teardown", async () => {
    expect((await settleDeferredGit("/work/site", reads(0), () => view())).update).toBeNull();
    expect(await settleDeferredGit("/work/site", reads(5), () => view({ stopped: true }))).toEqual({
      update: null,
      dirtyFailed: false,
    });
  });

  it("asks for a slow re-read when git gave no count", async () => {
    const result = await settleDeferredGit("/work/site", reads(new Error("timeout")), () => view());
    expect(result).toEqual({ update: null, dirtyFailed: true });
  });
});
