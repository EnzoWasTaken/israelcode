import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// os.homedir() reads USERPROFILE on Windows, so a HOME override would write to
// the real profile. Point homedir() at a temp dir instead.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const {
  appSettingsFile,
  loadAppSettings,
  loadOrchestrateDefault,
  loadWorkerModelPref,
  saveAutopilot,
  saveOrchestrateDefault,
  saveProjectModelPrefs,
  saveWorkerModelPref,
  updateAppSettings,
} = await import("./app-settings.js");

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-app-settings-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function readFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as Record<string, unknown>;
}

describe("gg-app.json writes from the sidecar", () => {
  it("keep keys owned by other writers (local endpoints, newer versions)", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        localEndpoints: [{ id: "lan", baseUrl: "http://h:1" }],
        someFutureKey: 7,
      }),
    );

    await saveAutopilot("/proj", true);

    const saved = await readFile();
    expect(saved.projectsRoot).toBe("/root");
    expect(saved.localEndpoints).toEqual([{ id: "lan", baseUrl: "http://h:1" }]);
    expect(saved.someFutureKey).toBe(7);
    expect(saved.autopilot).toEqual({ [path.resolve("/proj")]: true });
  });

  it("don't lose either change when two saves race", async () => {
    await Promise.all([
      saveAutopilot("/a", true),
      saveProjectModelPrefs("/b", { provider: "anthropic", model: "m" }),
      updateAppSettings((s) => {
        s.hiddenProjects = ["/c"];
      }),
    ]);

    const saved = await readFile();
    expect(saved.autopilot).toEqual({ [path.resolve("/a")]: true });
    expect(saved.projectModels).toEqual({
      [path.resolve("/b")]: { provider: "anthropic", model: "m" },
    });
    expect(saved.hiddenProjects).toEqual(["/c"]);
    await expect(fs.access(`${appSettingsFile()}.lock`)).rejects.toThrow();
  });
});

describe("native orchestration settings", () => {
  it("saves and clears the Worker model per project, dropping paid tiers", async () => {
    await saveWorkerModelPref("/a", { provider: "openai", model: "gpt-5-mini" });
    await saveWorkerModelPref("/b", { provider: "anthropic", model: "claude-opus-5-5-fast" });

    expect(await loadWorkerModelPref("/a")).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect((await loadWorkerModelPref("/b"))?.model).not.toMatch(/-fast$/);
    expect(await loadWorkerModelPref("/c")).toBeUndefined();

    await saveWorkerModelPref("/a", null);
    expect(await loadWorkerModelPref("/a")).toBeUndefined();
    const saved = await readFile();
    expect(Object.keys(saved.workerModels as object)).toEqual([path.resolve("/b")]);
  });

  it("drops malformed Worker entries on load and keeps the rest", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        workerModels: {
          [path.resolve("/ok")]: { provider: "openai", model: "gpt-5-mini" },
          [path.resolve("/no-model")]: { provider: "openai" },
          [path.resolve("/junk")]: "gpt-5-mini",
        },
        orchestrate: "yes",
      }),
    );
    const s = await loadAppSettings();
    expect(s.workerModels).toEqual({
      [path.resolve("/ok")]: { provider: "openai", model: "gpt-5-mini" },
    });
    expect(s.orchestrate).toBeUndefined();
  });

  it("remembers the Orchestrate default only while on", async () => {
    expect(await loadOrchestrateDefault()).toBe(false);
    await saveOrchestrateDefault(true);
    expect(await loadOrchestrateDefault()).toBe(true);
    expect((await readFile()).orchestrate).toBe(true);
    await saveOrchestrateDefault(false);
    expect(await loadOrchestrateDefault()).toBe(false);
    expect("orchestrate" in (await readFile())).toBe(false);
  });
});
