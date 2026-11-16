import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface OllamaServerStatus {
  managed: boolean;
  pid?: number;
  env: Record<string, string>;
}

export interface OllamaServerManager {
  status(): OllamaServerStatus;
  findBinary(): Promise<string | undefined>;
  start(env: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
}

export interface OllamaServerDeps {
  root?: string;
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createOllamaServerManager(deps: OllamaServerDeps = {}): OllamaServerManager {
  const root = (deps.root ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const spawnFn = deps.spawn ?? nodeSpawn;
  const fetchFn = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let startedEnv: Record<string, string> = {};

  const alive = () => !!child && child.exitCode === null && child.signalCode === null;

  async function answers(): Promise<boolean> {
    try {
      const res = await fetchFn(`${root}/api/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  async function findBinary(): Promise<string | undefined> {
    const win = platform === "win32";
    const exe = win ? "ollama.exe" : "ollama";
    const sep = win ? ";" : ":";
    for (const dir of (baseEnv.PATH ?? baseEnv.Path ?? "").split(sep)) {
      if (!dir) continue;
      const full = path.join(dir, exe);
      if (await exists(full)) return full;
    }
    const fallbacks: string[] = [];
    if (win && baseEnv.LOCALAPPDATA) {
      fallbacks.push(path.join(baseEnv.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
    } else if (platform === "darwin") {
      fallbacks.push("/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama");
    } else if (!win) {
      fallbacks.push("/usr/local/bin/ollama");
    }
    for (const f of fallbacks) if (await exists(f)) return f;
    return undefined;
  }

  async function stop(): Promise<void> {
    const c = child;
    if (!c || !alive()) {
      child = undefined;
      return;
    }
    const done = exited;
    const pid = c.pid;
    try {
      if (platform === "win32" && pid) {
        const k = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        k.on("error", () => c.kill());
      } else {
        c.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
    await Promise.race([done, sleep(5000)]);
    if (alive()) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await Promise.race([done, sleep(2000)]);
    }
    child = undefined;
  }

  async function start(env: Record<string, string>): Promise<void> {
    await stop();
    if (await answers()) {
      throw new Error(
        "Ollama is already running outside Israel Code. Quit it (tray icon, Quit Ollama), then start it here.",
      );
    }
    const binary = await findBinary();
    if (!binary) {
      throw new Error("Ollama is not installed. Install it from https://ollama.com/download.");
    }
    let spawnError: Error | undefined;
    const c = spawnFn(binary, ["serve"], {
      env: { ...baseEnv, ...env },
      windowsHide: true,
      stdio: "ignore",
    });
    child = c;
    startedEnv = { ...env };
    exited = new Promise<void>((resolve) => {
      c.once("exit", () => resolve());
      c.once("error", (err) => {
        spawnError = err;
        resolve();
      });
    });
    const fail = async (message: string): Promise<never> => {
      await stop();
      startedEnv = {};
      throw new Error(message);
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) return fail(`Could not start Ollama: ${spawnError.message}`);
      if (!alive()) return fail("Ollama exited right after starting. Check that the port is free.");
      if (await answers()) return;
      await sleep(250);
    }
    return fail(`Ollama did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  return {
    status: () =>
      alive()
        ? { managed: true, pid: child?.pid, env: { ...startedEnv } }
        : { managed: false, env: {} },
    findBinary,
    start,
    stop,
  };
}
