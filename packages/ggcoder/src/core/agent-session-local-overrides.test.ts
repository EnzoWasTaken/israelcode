import { afterEach, describe, expect, it } from "vitest";
import { formatLocalModelId, toModelInfo, type LocalEndpoint } from "@kenkaiiii/gg-core";
import { clearRuntimeModels, registerRuntimeModels } from "./model-registry.js";
import { localRequestOverrides } from "./agent-session.js";

const endpoint: LocalEndpoint = {
  id: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  kind: "ollama",
};
const id = formatLocalModelId("ollama", "qwen3:8b");
const model = {
  rawId: "qwen3:8b",
  endpointId: "ollama",
  contextWindow: 32768,
  contextWindowKnown: true,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

afterEach(() => clearRuntimeModels((m) => m.provider === "local"));

describe("localRequestOverrides", () => {
  it("returns the user's body fields and endpoint headers for local models", () => {
    registerRuntimeModels([
      toModelInfo(
        model,
        endpoint,
        { temperature: 0.2, extraBody: { num_ctx: 8192 } },
        {
          headers: { "X-Org": "abc" },
        },
      ),
    ]);
    expect(localRequestOverrides("local", id)).toEqual({
      providerOptions: { num_ctx: 8192, temperature: 0.2 },
      headers: { "X-Org": "abc" },
    });
  });

  it("routes Ollama models with runtime parameters to the derived model", () => {
    registerRuntimeModels([toModelInfo(model, endpoint, { gpuLayers: 12 })]);
    expect(localRequestOverrides("local", id)).toEqual({
      model: "local/ollama/qwen3:8b-israelcode",
    });
  });

  it("returns nothing without settings or for other providers", () => {
    registerRuntimeModels([toModelInfo(model, endpoint)]);
    expect(localRequestOverrides("local", id)).toEqual({});
    expect(localRequestOverrides("anthropic", id)).toEqual({});
  });
});
