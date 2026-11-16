/**
 * Persistence for per-model and per-endpoint local settings, under
 * `localSettings` in `~/.israelcode/gg-app.json`. Same lock + atomic write +
 * keep-other-keys pattern as the endpoint store. Never log values: they hold
 * header secrets and arbitrary request bodies.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  APP_DIR_NAME,
  parseLocalEndpointSettings,
  parseLocalModelId,
  parseLocalModelSettings,
  withFileLock,
  type LocalEndpointSettings,
  type LocalModelSettings,
  type LocalSettings,
} from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";

export interface LocalSettingsStoreOptions {
  /** Path to the gg-app settings file (defaults to `~/.israelcode/gg-app.json`). */
  settingsFile?: string;
}

function settingsPath(options: LocalSettingsStoreOptions): string {
  return options.settingsFile ?? path.join(os.homedir(), APP_DIR_NAME, "gg-app.json");
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value: object): boolean {
  return Object.keys(value).length === 0;
}

function parseStored(value: unknown): LocalSettings {
  const out: LocalSettings = { models: {}, endpoints: {} };
  if (!isRecord(value)) return out;
  const { models, endpoints } = value;
  if (isRecord(models)) {
    for (const [id, raw] of Object.entries(models)) {
      const { settings } = parseLocalModelSettings(raw);
      if (!isEmpty(settings)) out.models[id] = settings;
    }
  }
  if (isRecord(endpoints)) {
    for (const [id, raw] of Object.entries(endpoints)) {
      const { settings } = parseLocalEndpointSettings(raw);
      if (!isEmpty(settings)) out.endpoints[id] = settings;
    }
  }
  return out;
}

/** Stored local settings; invalid entries are dropped. Never throws. */
export async function loadLocalSettings(
  options: LocalSettingsStoreOptions = {},
): Promise<LocalSettings> {
  return parseStored((await readSettings(settingsPath(options)))["localSettings"]);
}

async function update(
  options: LocalSettingsStoreOptions,
  change: (current: LocalSettings) => void,
): Promise<LocalSettings> {
  const target = settingsPath(options);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let result: LocalSettings = { models: {}, endpoints: {} };
  await withFileLock(target, async () => {
    const file = await readSettings(target);
    const current = parseStored(file["localSettings"]);
    change(current);
    result = current;
    if (isEmpty(current.models) && isEmpty(current.endpoints)) delete file["localSettings"];
    else file["localSettings"] = current;
    await atomicWrite(target, JSON.stringify(file, null, 2));
  });
  return result;
}

/** Save (or, when empty/undefined, clear) one model's settings. */
export function setModelSettings(
  id: string,
  settings: LocalModelSettings | undefined,
  options: LocalSettingsStoreOptions = {},
): Promise<LocalSettings> {
  return update(options, (current) => {
    if (!settings || isEmpty(settings)) delete current.models[id];
    else current.models[id] = settings;
  });
}

/** Save (or, when empty/undefined, clear) one endpoint's settings. */
export function setEndpointSettings(
  id: string,
  settings: LocalEndpointSettings | undefined,
  options: LocalSettingsStoreOptions = {},
): Promise<LocalSettings> {
  return update(options, (current) => {
    if (!settings || isEmpty(settings)) delete current.endpoints[id];
    else current.endpoints[id] = settings;
  });
}

/** Drop an endpoint's settings and those of every model it served. */
export function removeEndpointSettings(
  endpointId: string,
  options: LocalSettingsStoreOptions = {},
): Promise<LocalSettings> {
  return update(options, (current) => {
    delete current.endpoints[endpointId];
    for (const id of Object.keys(current.models)) {
      if (parseLocalModelId(id)?.endpointId === endpointId) delete current.models[id];
    }
  });
}
