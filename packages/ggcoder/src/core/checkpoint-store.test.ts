import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "./checkpoint-store.js";

let cwd: string;
let baseDir: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-cp-cwd-"));
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-cp-store-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(baseDir, { recursive: true, force: true });
});

function store(maxCheckpoints?: number): CheckpointStore {
  return new CheckpointStore({ sessionId: "sess-1", cwd, baseDir, maxCheckpoints });
}

describe("CheckpointStore", () => {
  it("records pre-mutation content and restores original bytes after an edit", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "original");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 5 });
    await s.recordPreMutation(file);

    // Simulate an agent edit.
    await fs.writeFile(file, "mutated");
    expect(await fs.readFile(file, "utf-8")).toBe("mutated");

    const result = await s.restore("cp-0001", "code");
    expect(result.filesRestored).toBe(1);
    expect(result.messageIndex).toBe(5);
    expect(await fs.readFile(file, "utf-8")).toBe("original");
  });

  it("deletes files that were absent at the checkpoint when restoring code", async () => {
    const file = path.join(cwd, "new.txt");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 2 });
    // File does not exist yet at snapshot time.
    await s.recordPreMutation(file);

    // Agent creates the file.
    await fs.writeFile(file, "created by agent");

    await s.restore("cp-0001", "code");
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("dedupes identical content into a single blob", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    await fs.writeFile(a, "same bytes");
    await fs.writeFile(b, "same bytes");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 0 });
    await s.recordPreMutation(a);
    await s.recordPreMutation(b);

    const blobs = await fs.readdir(path.join(baseDir, "sess-1", "blobs"));
    expect(blobs).toHaveLength(1);
  });

  it("first-write-wins: a file mutated twice in one turn restores to pre-turn state", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "v0");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 0 });
    await s.recordPreMutation(file);
    await fs.writeFile(file, "v1");
    // Second mutation in the same turn — should NOT overwrite the v0 snapshot.
    await s.recordPreMutation(file);
    await fs.writeFile(file, "v2");

    await s.restore("cp-0001", "code");
    expect(await fs.readFile(file, "utf-8")).toBe("v0");
  });

  it("lists checkpoints in turn order with correct changed-file counts", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    await fs.writeFile(a, "a");
    await fs.writeFile(b, "b");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1 });
    await s.recordPreMutation(a);
    await s.openCheckpoint({ turnIndex: 2, messageIndex: 3 });
    await s.recordPreMutation(a);
    await s.recordPreMutation(b);

    const list = await s.listCheckpoints();
    expect(list.map((c) => c.turnIndex)).toEqual([1, 2]);
    expect(list[0].changedFileCount).toBe(1);
    expect(list[1].changedFileCount).toBe(2);
    expect(list[1].summary).toContain("a.txt");
    expect(list[1].summary).toContain("b.txt");
  });

  it("conversation restore reports the message index without touching files", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "original");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 9 });
    await s.recordPreMutation(file);
    await fs.writeFile(file, "mutated");

    const result = await s.restore("cp-0001", "conversation");
    expect(result.messageIndex).toBe(9);
    expect(result.filesRestored).toBe(0);
    // File left untouched in conversation-only mode.
    expect(await fs.readFile(file, "utf-8")).toBe("mutated");
  });

  it("prunes old checkpoints beyond the retention cap", async () => {
    const s = store(3);
    for (let turn = 1; turn <= 6; turn++) {
      await s.openCheckpoint({ turnIndex: turn, messageIndex: turn });
    }
    const list = await s.listCheckpoints();
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.turnIndex)).toEqual([4, 5, 6]);
  });
});

describe("pruneCheckpointSessions", () => {
  it("removes only folders whose every file is old, never follows symlinks", async () => {
    const { pruneCheckpointSessions } = await import("./checkpoint-store.js");
    const fsp = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const nodeOs = await import("node:os");
    const base = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "ckpt-prune-"));
    const outside = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "ckpt-outside-"));
    const old = new Date(Date.now() - 40 * 86_400_000);
    const mk = async (dir: string, name: string, when?: Date) => {
      await fsp.mkdir(nodePath.join(base, dir, "checkpoints"), { recursive: true });
      const f = nodePath.join(base, dir, "checkpoints", name);
      await fsp.writeFile(f, "x");
      if (when) await fsp.utimes(f, when, when);
    };
    await mk("old-session", "a.json", old);
    await mk("mixed-session", "a.json", old);
    await mk("mixed-session", "b.json"); // recent file keeps the folder
    await mk("new-session", "a.json");
    const outsideFile = nodePath.join(outside, "keep.txt");
    await fsp.writeFile(outsideFile, "keep");
    await fsp.utimes(outsideFile, old, old);
    await fsp.symlink(outside, nodePath.join(base, "link-session"));
    const res = await pruneCheckpointSessions({ baseDir: base, maxAgeDays: 30 });
    expect(res.removed).toBe(1);
    const left = (await fsp.readdir(base)).sort();
    expect(left).toEqual(["link-session", "mixed-session", "new-session"]);
    expect(await fsp.readFile(outsideFile, "utf-8")).toBe("keep");
    await fsp.rm(base, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });
});

describe("CheckpointStore.restoreTo", () => {
  it("undoes the chosen turn and every later one, back to the earliest snapshot", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    await fs.writeFile(a, "v0");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1, leafId: null, prompt: "one" });
    await s.recordPreMutation(a);
    await fs.writeFile(a, "v1");
    await s.openCheckpoint({ turnIndex: 2, messageIndex: 3, leafId: "e2", prompt: "two" });
    await s.recordPreMutation(b);
    await fs.writeFile(b, "new");
    await s.recordPreMutation(a);
    await fs.writeFile(a, "v2");

    expect((await s.listCheckpoints()).map((c) => [c.id, c.prompt, c.leafId, c.files])).toEqual([
      ["cp-0001", "one", null, ["a.txt"]],
      ["cp-0002", "two", "e2", ["b.txt", "a.txt"]],
    ]);
    expect((await s.restoreTo("cp-0001")).filesRestored).toBe(2);
    expect(await fs.readFile(a, "utf-8")).toBe("v0");
    await expect(fs.stat(b)).rejects.toThrow();
  });

  it("forgets rewound turns and refuses ids that aren't checkpoint names", async () => {
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1 });
    await s.openCheckpoint({ turnIndex: 2, messageIndex: 3 });
    await s.dropFrom("cp-0002");
    expect((await s.listCheckpoints()).map((c) => c.id)).toEqual(["cp-0001"]);
    await expect(s.restoreTo("../../escape")).rejects.toThrow("not found");
  });
});

describe("CheckpointStore.turnDiff", () => {
  it("reports each changed file against its state before the turn", async () => {
    const changed = path.join(cwd, "src", "a.ts");
    const same = path.join(cwd, "same.txt");
    const gone = path.join(cwd, "gone.txt");
    const added = path.join(cwd, "new.txt");
    await fs.mkdir(path.dirname(changed), { recursive: true });
    await fs.writeFile(changed, "one\ntwo\n");
    await fs.writeFile(same, "keep");
    await fs.writeFile(gone, "bye");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1 });
    for (const f of [changed, same, gone, added]) await s.recordPreMutation(f);
    await fs.writeFile(changed, "one\n2\nthree\n");
    await fs.writeFile(same, "keep"); // rewritten with the same bytes
    await fs.rm(gone);
    await fs.writeFile(added, "hi\n");

    const diff = await s.turnDiff("cp-0001");
    expect(diff.map((d) => [d.path, d.status, d.additions, d.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["gone.txt", "deleted", 0, 1],
      ["new.txt", "added", 1, 0],
    ]);
    expect(diff[0]!.patch).toContain("--- a/src/a.ts");
    expect(diff[0]!.patch).toContain("+three");

    expect(await s.revertFiles("cp-0001", ["src/a.ts", "new.txt"])).toBe(2);
    expect(await fs.readFile(changed, "utf-8")).toBe("one\ntwo\n");
    await expect(fs.stat(added)).rejects.toThrow();
    expect((await s.turnDiff("cp-0001")).map((d) => d.path)).toEqual(["gone.txt"]);
  });

  it("marks binary files without a patch", async () => {
    const bin = path.join(cwd, "img.bin");
    await fs.writeFile(bin, Buffer.from([1, 0, 2]));
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1 });
    await s.recordPreMutation(bin);
    await fs.writeFile(bin, Buffer.from([1, 0, 3]));
    expect(await s.turnDiff("cp-0001")).toEqual([
      { path: "img.bin", status: "modified", additions: 0, deletions: 0, binary: true },
    ]);
  });
});
