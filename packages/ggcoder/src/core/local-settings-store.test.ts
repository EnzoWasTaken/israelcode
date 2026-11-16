import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalModelId } from "@kenkaiiii/gg-core";
import {
  loadLocalSettings,
  removeEndpointSettings,
  setEndpointSettings,
  setModelSettings,
  type LocalSettingsStoreOptions,
} from "./local-settings-store.js";

let dir: string;
let opts: LocalSettingsStoreOptions;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-local-settings-"));
  opts = { settingsFile: path.join(dir, "gg-app.json") };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ollama = formatLocalModelId("ollama", "qwen3:8b");
const other = formatLocalModelId("custom-box-1", "llama");

describe("local settings store", () => {
  it("round-trips model and endpoint settings and keeps other keys", async () => {
    await fs.writeFile(opts.settingsFile!, JSON.stringify({ theme: "dark" }));
    await setModelSettings(ollama, { contextWindow: 32768, temperature: 0.2 }, opts);
    await setEndpointSettings("custom-box-1", { headers: { "X-Org": "abc" } }, opts);
    expect(await loadLocalSettings(opts)).toEqual({
      models: { [ollama]: { contextWindow: 32768, temperature: 0.2 } },
      endpoints: { "custom-box-1": { headers: { "X-Org": "abc" } } },
    });
    const file = JSON.parse(await fs.readFile(opts.settingsFile!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(file["theme"]).toBe("dark");
  });

  it("deletes entries saved empty and the whole key when nothing is left", async () => {
    await setModelSettings(ollama, { maxOutputTokens: 8000 }, opts);
    await setModelSettings(ollama, {}, opts);
    const file = JSON.parse(await fs.readFile(opts.settingsFile!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(file).not.toHaveProperty("localSettings");
    expect(await loadLocalSettings(opts)).toEqual({ models: {}, endpoints: {} });
  });

  it("removing an endpoint drops its settings and its models' settings only", async () => {
    await setModelSettings(ollama, { topK: 40 }, opts);
    await setModelSettings(other, { topK: 20 }, opts);
    await setEndpointSettings("custom-box-1", { headers: { "X-A": "1" } }, opts);
    await removeEndpointSettings("custom-box-1", opts);
    expect(await loadLocalSettings(opts)).toEqual({
      models: { [ollama]: { topK: 40 } },
      endpoints: {},
    });
  });

  it("drops invalid stored entries silently on load", async () => {
    await fs.writeFile(
      opts.settingsFile!,
      JSON.stringify({
        localSettings: {
          models: { [ollama]: { temperature: 9, topK: 5 }, bad: "x" },
          endpoints: 3,
        },
      }),
    );
    expect(await loadLocalSettings(opts)).toEqual({
      models: { [ollama]: { topK: 5 } },
      endpoints: {},
    });
  });
});
