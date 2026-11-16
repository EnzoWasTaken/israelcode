import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createOllamaServerManager } from "./ollama-server.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  });
}

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-bin-"));
const exeName = process.platform === "win32" ? "ollama.exe" : "ollama";
fs.writeFileSync(path.join(binDir, exeName), "");
afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

function setup(opts: { withBinary?: boolean; alwaysUp?: boolean; neverUp?: boolean } = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  let up = !!opts.alwaysUp;
  const spawn = vi.fn((cmd: string, args: string[], o: Record<string, unknown>) => {
    calls.push({ cmd, args, opts: o });
    const c = new FakeChild();
    children.push(c);
    if (cmd === "taskkill") queueMicrotask(() => children[0].kill());
    else if (!opts.neverUp) queueMicrotask(() => (up = true));
    return c;
  });
  const fetchFn = vi.fn(async () => ({ ok: up }) as Response);
  const mgr = createOllamaServerManager({
    spawn: spawn as never,
    fetch: fetchFn as never,
    platform: process.platform,
    env: { PATH: opts.withBinary === false ? "" : binDir, KEEP: "1" },
    timeoutMs: 600,
  });
  return { mgr, spawn, calls, children };
}

describe("ollama server manager", () => {
  it("rejects when the binary is missing", async () => {
    const { mgr, spawn } = setup({ withBinary: false });
    await expect(mgr.start({})).rejects.toThrow(/not installed/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to take over a server it did not start", async () => {
    const { mgr, spawn } = setup({ alwaysUp: true });
    await expect(mgr.start({})).rejects.toThrow(/already running outside Israel Code/);
    expect(spawn).not.toHaveBeenCalled();
    expect(mgr.status().managed).toBe(false);
  });

  it("stop is a no-op when nothing is managed", async () => {
    const { mgr, spawn } = setup();
    await mgr.stop();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns serve with merged env and reports status", async () => {
    const { mgr, calls } = setup();
    await mgr.start({ OLLAMA_FLASH_ATTENTION: "1" });
    expect(calls[0].args).toEqual(["serve"]);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.stdio).toBe("ignore");
    expect(calls[0].opts.env).toMatchObject({ KEEP: "1", OLLAMA_FLASH_ATTENTION: "1" });
    expect(mgr.status()).toEqual({
      managed: true,
      pid: 4242,
      env: { OLLAMA_FLASH_ATTENTION: "1" },
    });
    await mgr.stop();
    expect(mgr.status().managed).toBe(false);
  });

  it("kills the child and rejects when the server never answers", async () => {
    const { mgr, children } = setup({ neverUp: true });
    await expect(mgr.start({})).rejects.toThrow(/did not answer/);
    expect(children[0].kill).toHaveBeenCalled();
    expect(mgr.status().managed).toBe(false);
  });

  it("rejects when the child exits early", async () => {
    const { mgr, children } = setup({ neverUp: true });
    const p = mgr.start({});
    await new Promise((r) => setTimeout(r, 50));
    children[0].exitCode = 1;
    children[0].emit("exit", 1);
    await expect(p).rejects.toThrow(/exited/);
  });
});
