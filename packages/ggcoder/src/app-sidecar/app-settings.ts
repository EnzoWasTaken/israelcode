import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { KenModelPref } from "../core/ken-model.js";
import { SettingsManager, type Settings } from "../core/settings-manager.js";
import { log } from "../core/logger.js";
import { atomicWrite } from "../core/session-storage.js";
import { withFileLock, withoutPaidTier, APP_DIR_NAME } from "@kenkaiiii/gg-core";

export const ALL_PROVIDERS: Provider[] = [
  // US
  "anthropic",
  "openai",
  "gemini",
  "xai",
  // China
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  // Open-community gateway, before the provider-agnostic one
  "huggingface",
  // Japan, then provider-agnostic gateway last
  "sakana",
  "openrouter",
];

// ── gg-app settings (~/.israelcode/gg-app.json) ────────────────────
// App-specific, separate from the shared ggcoder settings file so the desktop
// app's preferences never collide with the CLI's.

/** Per-project model + thinking preferences. Persisted so each window (one
 *  project cwd) restores its OWN model across app restarts — instead of every
 *  window reading the same single global slot that the last writer clobbered. */
export interface ProjectModelPrefs {
  provider: Provider;
  model: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface AppSettings {
  /** Folder new projects are created inside. Defaults to ~/gg-projects. */
  projectsRoot: string;
  /** Model + thinking prefs keyed by normalized project cwd. A window restores
   *  its own entry on boot; absent → global settings.json → provider default. */
  projectModels?: Record<string, ProjectModelPrefs>;
  /** Autopilot (auto-review) on/off keyed by normalized project cwd. Per-window
   *  (one window = one cwd); absent/false → off. Restored on boot. */
  autopilot?: Record<string, boolean>;
  /** Ken's model override keyed by normalized project cwd. Absent → Ken follows
   *  GG Coder's model (the historical behavior). Set → Ken (chat + autopilot)
   *  uses this model regardless of GG Coder's. */
  kenModels?: Record<string, KenModelPref>;
  /** Extra folders scanned for projects alongside `projectsRoot`. */
  projectRoots?: string[];
  /** Project paths dismissed from the picker, as normalized cwds. */
  hiddenProjects?: string[];
  /** Projects (normalized cwds) where the user's own `!` commands run without asking. */
  shellTrusted?: string[];
  /** The Worker model Orchestrate hands pieces to, keyed by normalized project cwd.
   *  Absent → workers follow the orchestrator (the window's main model). */
  workerModels?: Record<string, WorkerModelPref>;
  /** Orchestrate on by default in new coding sessions (the last toggle wins). */
  orchestrate?: boolean;
  /** Ultracode on by default in new coding sessions (the last toggle wins). */
  ultracode?: boolean;
  /** Permission mode for new coding sessions (the last choice wins; unset = bypass). */
  permissionMode?: "ask" | "accept-edits";
  /** Per project: commands the user chose to always allow under Ask / Accept edits. */
  allowedCommands?: Record<string, string[]>;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

export function appSettingsFile(): string {
  return path.join(os.homedir(), APP_DIR_NAME, "gg-app.json");
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), "gg-projects");
}

/** Normalize a project cwd to a stable settings key so trailing slashes /
 *  relative segments collapse — the same project always maps to one entry. */
export function projectModelKey(cwd: string): string {
  return path.resolve(cwd);
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { projectsRoot: defaultProjectsRoot() };
    }
    const raw = parsed as Partial<AppSettings>;
    return {
      // Keep every key this module doesn't own (localEndpoints, fields a newer
      // app version or the Rust side writes) so a save never drops them.
      ...raw,
      projectsRoot:
        typeof raw.projectsRoot === "string" && raw.projectsRoot.trim()
          ? raw.projectsRoot
          : defaultProjectsRoot(),
      // Preserve the per-project map verbatim (validated + written by the
      // model/thinking handlers below).
      projectModels:
        raw.projectModels && typeof raw.projectModels === "object" ? raw.projectModels : undefined,
      autopilot: raw.autopilot && typeof raw.autopilot === "object" ? raw.autopilot : undefined,
      kenModels: raw.kenModels && typeof raw.kenModels === "object" ? raw.kenModels : undefined,
      projectRoots: stringArray(raw.projectRoots),
      hiddenProjects: stringArray(raw.hiddenProjects),
      shellTrusted: stringArray(raw.shellTrusted),
      ultracode: raw.ultracode === true ? true : undefined,
      workerModels: validWorkerModels(raw.workerModels),
      orchestrate: raw.orchestrate === true ? true : undefined,
      permissionMode:
        raw.permissionMode === "ask" || raw.permissionMode === "accept-edits"
          ? raw.permissionMode
          : undefined,
      allowedCommands:
        raw.allowedCommands && typeof raw.allowedCommands === "object"
          ? Object.fromEntries(
              Object.entries(raw.allowedCommands as Record<string, unknown>).flatMap(([k, v]) => {
                const list = stringArray(v);
                return list ? [[k, list]] : [];
              }),
            )
          : undefined,
    };
  } catch {
    return { projectsRoot: defaultProjectsRoot() };
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  await atomicWrite(appSettingsFile(), JSON.stringify(settings, null, 2));
}

/**
 * Read-modify-write gg-app.json under the shared file lock, so two windows
 * saving at once (or a local-endpoint save racing a model save) can't lose
 * each other's change. Every settings write in the sidecar goes through here.
 */
export async function updateAppSettings<T = void>(
  mutate: (settings: AppSettings) => T | Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  return withFileLock(appSettingsFile(), async () => {
    const s = await loadAppSettings();
    const result = await mutate(s);
    await saveAppSettings(s);
    return result;
  });
}

/** Read this project's persisted model/thinking prefs, if any. */
export async function loadProjectModelPrefs(cwd: string): Promise<ProjectModelPrefs | undefined> {
  const s = await loadAppSettings();
  const prefs = s.projectModels?.[projectModelKey(cwd)];
  // A paid tier (Claude fast mode) never comes back on its own: a restored or
  // new session starts on the standard model and the user opts in again.
  return prefs ? { ...prefs, model: withoutPaidTier(prefs.model) } : undefined;
}

/** Persist this project's model/thinking prefs via read-modify-write so the rest
 *  of the settings file (projectsRoot, other projects' entries) is preserved. */
export async function saveProjectModelPrefs(cwd: string, prefs: ProjectModelPrefs): Promise<void> {
  const key = projectModelKey(cwd);
  const safe = { ...prefs, model: withoutPaidTier(prefs.model) };
  await updateAppSettings((s) => {
    s.projectModels = { ...(s.projectModels ?? {}), [key]: safe };
  });
}

/** Read this project's persisted Ken model override, if any. */
export async function loadKenModelPref(cwd: string): Promise<KenModelPref | undefined> {
  const s = await loadAppSettings();
  const pref = s.kenModels?.[projectModelKey(cwd)];
  return pref ? { ...pref, model: withoutPaidTier(pref.model) } : undefined;
}

/** Persist (or with null, clear) this project's Ken model override via
 *  read-modify-write so the rest of the settings file is preserved. */
export async function saveKenModelPref(cwd: string, pref: KenModelPref | null): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    const next = { ...(s.kenModels ?? {}) };
    if (pref) next[key] = pref;
    else delete next[key];
    s.kenModels = next;
  });
}

/** Read this project's persisted autopilot flag (default off). */
export async function loadAutopilot(cwd: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.autopilot?.[projectModelKey(cwd)] ?? false;
}

/** Persist this project's autopilot flag via read-modify-write so the rest of
 *  the settings file (projectsRoot, model map, other projects) is preserved. */
export async function saveAutopilot(cwd: string, enabled: boolean): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    s.autopilot = { ...(s.autopilot ?? {}), [key]: enabled };
  });
}

/** Whether new coding sessions start with Ultracode on (default off). */
export async function loadUltracodeDefault(): Promise<boolean> {
  return (await loadAppSettings()).ultracode === true;
}

/** Remember the last Ultracode toggle as the default for new sessions. */
export async function saveUltracodeDefault(enabled: boolean): Promise<void> {
  await updateAppSettings((s) => {
    if (enabled) s.ultracode = true;
    else delete s.ultracode;
  });
}

export async function loadPermissionModeDefault(): Promise<"bypass" | "ask" | "accept-edits"> {
  return (await loadAppSettings()).permissionMode ?? "bypass";
}

export async function savePermissionModeDefault(
  mode: "bypass" | "ask" | "accept-edits",
): Promise<void> {
  await updateAppSettings((s) => {
    if (mode === "bypass") delete s.permissionMode;
    else s.permissionMode = mode;
  });
}

/** Whether this exact command was set to "always allow" in this project. */
export async function isCommandAlwaysAllowed(cwd: string, command: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.allowedCommands?.[projectModelKey(cwd)]?.includes(command.trim()) ?? false;
}

export async function allowCommandAlways(cwd: string, command: string): Promise<void> {
  const key = projectModelKey(cwd);
  const trimmed = command.trim();
  if (!trimmed) return;
  await updateAppSettings((s) => {
    const list = s.allowedCommands?.[key] ?? [];
    if (list.includes(trimmed)) return;
    s.allowedCommands = { ...s.allowedCommands, [key]: [...list, trimmed] };
  });
}

/** Whether the user's own `!` commands in this project run without asking. */
export async function loadShellTrusted(cwd: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.shellTrusted?.includes(projectModelKey(cwd)) ?? false;
}

export async function saveShellTrusted(cwd: string, trusted: boolean): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    const rest = (s.shellTrusted ?? []).filter((p) => p !== key);
    s.shellTrusted = trusted ? [...rest, key] : rest.length > 0 ? rest : undefined;
  });
}

/**
 * Persist the active model selection to ~/.israelcode/settings.json so it survives app
 * restarts. Mirrors the CLI's handleModelSelect persistence (App.tsx).
 */
export async function persistModelSelection(
  settingsFile: string,
  provider: Provider,
  model: string,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("defaultProvider", provider as Settings["defaultProvider"]);
    // Never persist a paid tier as the default every new session boots with.
    await sm.set("defaultModel", withoutPaidTier(model));
  } catch (err) {
    log("WARN", "app-sidecar", "failed to persist model selection", { err: String(err) });
  }
}

/**
 * Persist the thinking level to ~/.israelcode/settings.json so it survives app restarts.
 * Mirrors the CLI's handleToggleThinking persistence (App.tsx).
 */
export async function persistThinkingLevel(
  settingsFile: string,
  level: ThinkingLevel | undefined,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("thinkingEnabled", !!level);
    if (level) await sm.set("thinkingLevel", level);
  } catch (err) {
    log("WARN", "app-sidecar", "failed to persist thinking level", { err: String(err) });
  }
}

// ── History reconstruction types ──────────────────────────
// Mirrors HistoryEntry in gg-app/src/agent.ts — the wire shape the webview
// receives from GET /history. Fields beyond role/text carry the transcript

// ── Native orchestration: the Worker model and the Orchestrate default ──────

/** A pinned Worker model: provider + model id (what Orchestrate's children run on). */
export interface WorkerModelPref {
  provider: Provider;
  model: string;
}

/** Keep only well-formed entries so a hand-edited file can't break session start. */
function validWorkerModels(value: unknown): Record<string, WorkerModelPref> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, WorkerModelPref> = {};
  for (const [key, pref] of Object.entries(value as Record<string, unknown>)) {
    if (!pref || typeof pref !== "object") continue;
    const { provider, model } = pref as { provider?: unknown; model?: unknown };
    if (typeof provider !== "string" || !provider.trim()) continue;
    if (typeof model !== "string" || !model.trim()) continue;
    out[key] = { provider: provider as Provider, model };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read this project's persisted Worker model, if any (never a paid tier). */
export async function loadWorkerModelPref(cwd: string): Promise<WorkerModelPref | undefined> {
  const s = await loadAppSettings();
  const pref = s.workerModels?.[projectModelKey(cwd)];
  return pref ? { ...pref, model: withoutPaidTier(pref.model) } : undefined;
}

/** Persist (or with null, clear) this project's Worker model via read-modify-write. */
export async function saveWorkerModelPref(
  cwd: string,
  pref: WorkerModelPref | null,
): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    const next = { ...(s.workerModels ?? {}) };
    if (pref) next[key] = { provider: pref.provider, model: withoutPaidTier(pref.model) };
    else delete next[key];
    s.workerModels = Object.keys(next).length > 0 ? next : undefined;
  });
}

/** Whether new coding sessions start with Orchestrate on (default off). */
export async function loadOrchestrateDefault(): Promise<boolean> {
  return (await loadAppSettings()).orchestrate === true;
}

/** Remember the last Orchestrate toggle as the default for new sessions. */
export async function saveOrchestrateDefault(enabled: boolean): Promise<void> {
  await updateAppSettings((s) => {
    if (enabled) s.orchestrate = true;
    else delete s.orchestrate;
  });
}
