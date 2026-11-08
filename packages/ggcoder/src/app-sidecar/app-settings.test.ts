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
  loadBudgetPref,
  saveBudgetPref,
  loadVerifyEnabled,
  saveVerifyEnabled,
  loadHooksEnabled,
  saveHooksEnabled,
  loadCompactionPref,
  saveCompactionPref,
  loadOrchestrateDefault,
  loadWorkerModelPref,
  saveAutopilot,
  saveOrchestrateDefault,
  saveProjectModelPrefs,
  saveWorkerModelPref,
  loadWorktreeWorkersPref,
  saveWorktreeWorkersPref,
  updateAppSettings,
  loadAutoRouteConfig,
  saveAutoRouteConfig,
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

describe("budget settings", () => {
  it("defaults to no caps with the runaway stop on", async () => {
    expect(await loadBudgetPref("/proj")).toEqual({ hardStopOnRunaway: true });
  });

  it("saves caps per project, drops a default entry and keeps other settings", async () => {
    await saveAutopilot("/proj", true);
    await saveBudgetPref("/proj", { sessionTokens: 200_000, hardStopOnRunaway: true });
    expect(await loadBudgetPref("/proj")).toEqual({
      sessionTokens: 200_000,
      hardStopOnRunaway: true,
    });
    expect(await loadBudgetPref("/other")).toEqual({ hardStopOnRunaway: true });
    await saveBudgetPref("/other", { dayTokens: 1_000_000.7, hardStopOnRunaway: false });
    expect(await loadBudgetPref("/other")).toEqual({
      dayTokens: 1_000_000,
      hardStopOnRunaway: false,
    });
    const file = await readFile();
    expect(file.autopilot).toEqual({ [path.resolve("/proj")]: true });
    expect(file.budgets).toEqual({
      [path.resolve("/proj")]: { sessionTokens: 200_000 },
      [path.resolve("/other")]: { dayTokens: 1_000_000, hardStopOnRunaway: false },
    });
    await saveBudgetPref("/proj", { hardStopOnRunaway: true });
    await saveBudgetPref("/other", {});
    expect("budgets" in (await readFile())).toBe(false);
  });

  it("ignores malformed budget entries on load", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        budgets: {
          [path.resolve("/ok")]: { sessionTokens: 5000, hardStopOnRunaway: "no" },
          [path.resolve("/neg")]: { sessionTokens: -5, dayTokens: "lots" },
          [path.resolve("/junk")]: 42,
        },
      }),
    );
    expect((await loadAppSettings()).budgets).toEqual({
      [path.resolve("/ok")]: { sessionTokens: 5000 },
    });
  });
});

describe("verify settings", () => {
  it("is off by default and saves the switch per project", async () => {
    expect(await loadVerifyEnabled("/proj")).toBe(false);
    await saveVerifyEnabled("/proj", true);
    expect(await loadVerifyEnabled("/proj")).toBe(true);
    expect(await loadVerifyEnabled("/other")).toBe(false);
    expect((await readFile()).verify).toEqual({ [path.resolve("/proj")]: { enabled: true } });
    await saveVerifyEnabled("/proj", false);
    expect("verify" in (await readFile())).toBe(false);
  });

  it("ignores malformed verify entries on load", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        verify: {
          [path.resolve("/on")]: { enabled: true },
          [path.resolve("/str")]: { enabled: "yes" },
          [path.resolve("/junk")]: 1,
        },
      }),
    );
    expect((await loadAppSettings()).verify).toEqual({ [path.resolve("/on")]: { enabled: true } });
  });
});

describe("worktree workers settings", () => {
  it("defaults to on with no auto-merge when unset", async () => {
    expect(await loadWorktreeWorkersPref("/proj")).toEqual({ enabled: true, autoMerge: "never" });
  });

  it("persists autoMerge per project and drops the entry when saved back to defaults", async () => {
    await saveWorktreeWorkersPref("/proj", { autoMerge: "clean-and-verified" });
    expect(await loadWorktreeWorkersPref("/proj")).toEqual({
      enabled: true,
      autoMerge: "clean-and-verified",
    });
    expect(await loadWorktreeWorkersPref("/other")).toEqual({ enabled: true, autoMerge: "never" });
    await saveWorktreeWorkersPref("/proj", { autoMerge: "never" });
    expect("worktreeWorkers" in (await readFile())).toBe(false);
  });
});

describe("hooks settings", () => {
  it("is off by default and saves the switch per project", async () => {
    expect(await loadHooksEnabled("/proj")).toBe(false);
    await saveHooksEnabled("/proj", true);
    expect(await loadHooksEnabled("/proj")).toBe(true);
    expect(await loadHooksEnabled("/other")).toBe(false);
    expect((await readFile()).hooks).toEqual({ [path.resolve("/proj")]: { enabled: true } });
    await saveHooksEnabled("/proj", false);
    expect("hooks" in (await readFile())).toBe(false);
  });

  it("ignores malformed hooks entries on load", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        hooks: {
          [path.resolve("/on")]: { enabled: true },
          [path.resolve("/str")]: { enabled: "yes" },
          [path.resolve("/junk")]: 1,
        },
      }),
    );
    expect((await loadAppSettings()).hooks).toEqual({ [path.resolve("/on")]: { enabled: true } });
  });
});

describe("compaction settings", () => {
  it("saves the trigger and pins per project and drops an empty entry", async () => {
    expect(await loadCompactionPref("/proj")).toEqual({ pins: [] });
    const saved = await saveCompactionPref("/proj", {
      threshold: 0.7,
      atTokens: null,
      pins: [" keep this ", "", "keep this"],
    });
    expect(saved).toEqual({ threshold: 0.7, atTokens: null, pins: ["keep this"] });
    expect(await loadCompactionPref("/proj")).toEqual(saved);
    expect(await loadCompactionPref("/other")).toEqual({ pins: [] });
    expect((await readFile()).compaction).toEqual({ [path.resolve("/proj")]: saved });
    await saveCompactionPref("/proj", { pins: [] });
    expect("compaction" in (await readFile())).toBe(false);
  });

  it("ignores malformed compaction entries on load", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        compaction: {
          [path.resolve("/ok")]: { threshold: 0.6, pins: ["a"] },
          [path.resolve("/low")]: { threshold: 0.1 },
          [path.resolve("/junk")]: 3,
        },
      }),
    );
    expect((await loadAppSettings()).compaction).toEqual({
      [path.resolve("/ok")]: { threshold: 0.6, pins: ["a"] },
    });
  });
});

describe("Auto routing config", () => {
  it("defaults to off when missing or malformed (silent migration)", async () => {
    expect((await loadAutoRouteConfig()).enabled).toBe(false);
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(appSettingsFile(), JSON.stringify({ projectsRoot: "/r", autoRoute: 5 }));
    const cfg = await loadAutoRouteConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.decider).toBeNull();
  });

  it("round-trips and keeps other keys", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(appSettingsFile(), JSON.stringify({ projectsRoot: "/r", other: 1 }));
    const cfg = await loadAutoRouteConfig();
    await saveAutoRouteConfig({
      ...cfg,
      enabled: true,
      decider: { kind: "decisions-api", service: "typesafe", model: "jev-latest" },
    });
    const loaded = await loadAutoRouteConfig();
    expect(loaded.enabled).toBe(true);
    expect(loaded.decider).toEqual({
      kind: "decisions-api",
      service: "typesafe",
      model: "jev-latest",
    });
    expect((await readFile()).other).toBe(1);
  });
});
