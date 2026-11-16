import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_ENDPOINTS,
  FALLBACK_CONTEXT_WINDOW,
  applyLocalModelSettings,
  clearLocalDiscoveryCache,
  localRequestBody,
  parseLocalEndpointSettings,
  parseLocalModelSettings,
  discoverLocalModels,
  endpointRoot,
  findProbedModel,
  formatLocalModelId,
  isLocalModelId,
  localAuthStorageKey,
  localModelShortName,
  ollamaServedContext,
  deleteOllamaDerivedModel,
  ensureOllamaDerivedModel,
  isOllamaDerivedName,
  ollamaDerivedName,
  ollamaModelParameters,
  ollamaServerEnv,
  parseLocalModelId,
  probeEndpoint,
  toModelInfo,
  type LocalEndpoint,
  type LocalEndpointKind,
} from "./local-models.js";

type Routes = Record<string, unknown>;

/** Minimal fake server: exact-path JSON routes, 404 for anything else. */
async function startServer(
  routes: Routes,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: (() => Promise<void>)[] = [];

async function endpointFor(kind: LocalEndpointKind, routes: Routes): Promise<LocalEndpoint> {
  const { baseUrl, close } = await startServer(routes);
  cleanups.push(close);
  return { id: kind, label: kind, baseUrl, kind };
}

afterEach(async () => {
  clearLocalDiscoveryCache();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

describe("model id round-trip", () => {
  it("formats and parses ids, including raw ids containing slashes", () => {
    const id = formatLocalModelId("ollama", "hf.co/user/repo:q4");
    expect(id).toBe("local/ollama/hf.co/user/repo:q4");
    expect(parseLocalModelId(id)).toEqual({
      endpointId: "ollama",
      rawId: "hf.co/user/repo:q4",
    });
    expect(isLocalModelId(id)).toBe(true);
  });

  it("rejects non-local and malformed ids", () => {
    expect(parseLocalModelId("claude-sonnet-5")).toBeUndefined();
    expect(parseLocalModelId("local/ollama")).toBeUndefined();
    expect(parseLocalModelId("local/ollama/")).toBeUndefined();
    expect(parseLocalModelId("local//qwen")).toBeUndefined();
    expect(isLocalModelId("gpt-6.1-sol")).toBe(false);
  });

  it("derives the auth storage key from the endpoint id", () => {
    expect(localAuthStorageKey("lmstudio")).toBe("local:lmstudio");
  });

  it("strips the /v1 suffix to reach the server root", () => {
    expect(endpointRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(endpointRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(endpointRoot("http://host/openai/v1")).toBe("http://host/openai");
  });
});

describe("probeEndpoint — Ollama", () => {
  it("waits for a model list that takes longer than the per-model lookups", async () => {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0]!;
      const send = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/v1/models") setTimeout(() => send({ data: [{ id: "llama3.2:3b" }] }), 1600);
      else if (path === "/api/ps") send({ models: [] });
      else if (path === "/api/show") send({ capabilities: ["completion", "tools"] });
      else res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const endpoint: LocalEndpoint = {
      id: "ollama",
      label: "ollama",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      kind: "ollama",
    };

    const probe = await probeEndpoint(endpoint);

    expect(probe.reachable).toBe(true);
    expect(probe.models.map((m) => m.rawId)).toEqual(["llama3.2:3b"]);
  });

  it("reads capabilities but uses the running allocation, not the architecture maximum", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "qwen3-coder:30b" }, { id: "nomic-embed-text" }] },
      "/api/ps": { models: [{ name: "qwen3-coder:30b", context_length: 4096 }] },
      "/api/show": {
        capabilities: ["completion", "tools", "vision", "thinking"],
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.reachable).toBe(true);
    // The embedding model is filtered out by id.
    expect(probe.models).toHaveLength(1);
    expect(probe.models[0]).toMatchObject({
      rawId: "qwen3-coder:30b",
      contextWindow: 4096,
      contextWindowKnown: true,
      supportsTools: true,
      supportsImages: true,
      supportsThinking: true,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { models: [] },
    { models: [{ name: "model", context_length: -1 }] },
  ])(
    "does not report the training maximum when running context is unavailable: %j",
    async (running) => {
      const endpoint = await endpointFor("ollama", {
        "/v1/models": { data: [{ id: "model" }] },
        "/api/ps": running,
        "/api/show": {
          capabilities: ["completion"],
          model_info: { "qwen.context_length": 262144 },
        },
      });
      const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
      expect(probe.models[0]).toMatchObject({
        contextWindow: FALLBACK_CONTEXT_WINDOW,
        contextWindowKnown: false,
      });
      expect(FALLBACK_CONTEXT_WINDOW).toBeLessThanOrEqual(4096);
    },
  );

  it("drops embedding models whose id carries no hint (real: all-minilm)", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "all-minilm:latest" }, { id: "llama3.2:latest" }] },
      // Both ids hit the same fixture route; the per-model capability answer is
      // what distinguishes them, so serve the embedding shape and assert the
      // chat model survives on a second, tool-capable fixture below.
      "/api/show": { capabilities: ["embedding"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.reachable).toBe(true);
    expect(probe.models).toEqual([]);
  });

  it("keeps a model that both embeds and completes", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "hybrid" }] },
      "/api/show": { capabilities: ["embedding", "completion", "tools"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models.map((m) => m.rawId)).toEqual(["hybrid"]);
  });

  it("reports no tool support when Ollama omits the tools capability", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "gemma3:4b" }] },
      "/api/show": { capabilities: ["completion"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      supportsTools: false,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — LM Studio", () => {
  it("prefers v1 loaded instances and matches custom instance ids", async () => {
    const endpoint = await endpointFor("lmstudio", {
      "/v1/models": { data: [{ id: "custom-instance" }, { id: "qwen-vl" }, { id: "unloaded" }] },
      "/api/v1/models": {
        models: [
          {
            key: "qwen-vl",
            type: "llm",
            max_context_length: 262144,
            capabilities: { vision: true },
            loaded_instances: [
              { id: "custom-instance", config: { context_length: 8192 } },
              { id: "second-instance", config: { context_length: 4096 } },
            ],
          },
          { key: "unloaded", type: "llm", max_context_length: 262144, loaded_instances: [] },
        ],
      },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({
      contextWindow: 8192,
      contextWindowKnown: true,
      supportsImages: true,
      loaded: true,
    });
    expect(probe.models[1]).toMatchObject({
      contextWindow: 4096,
      contextWindowKnown: true,
      loaded: true,
    });
    expect(probe.models[2]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
      loaded: false,
    });
  });

  it("uses /api/v0/models for context + type and drops embeddings", async () => {
    const endpoint = await endpointFor("lmstudio", {
      "/v1/models": {
        data: [{ id: "qwen3-vl-8b" }, { id: "text-model" }, { id: "some-embeddings-model" }],
      },
      "/api/v0/models": {
        data: [
          {
            id: "qwen3-vl-8b",
            type: "vlm",
            state: "loaded",
            max_context_length: 32768,
            loaded_context_length: 4096,
          },
          { id: "text-model", type: "llm", state: "not-loaded", max_context_length: 8192 },
          { id: "some-embeddings-model", type: "embeddings", state: "loaded" },
        ],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models.map((m) => m.rawId)).toEqual(["qwen3-vl-8b", "text-model"]);
    expect(probe.models[0]).toMatchObject({
      supportsImages: true,
      contextWindow: 4096,
      contextWindowKnown: true,
      loaded: true,
    });
    expect(probe.models[1]).toMatchObject({
      supportsImages: false,
      loaded: false,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — llama.cpp", () => {
  it("takes n_ctx from /props", async () => {
    const endpoint = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "local-gguf" }] },
      "/props": { default_generation_settings: { n_ctx: 16384 } },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      rawId: "local-gguf",
      contextWindow: 16384,
      contextWindowKnown: true,
      supportsTools: true,
    });
  });

  it("falls back conservatively when /props is missing", async () => {
    const endpoint = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "local-gguf" }] },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — generic / vLLM", () => {
  it("uses max_model_len from the model object when present", async () => {
    const endpoint = await endpointFor("vllm", {
      "/v1/models": {
        data: [{ id: "Qwen/Qwen3-32B", max_model_len: 40960 }, { id: "no-len-model" }],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({ contextWindow: 40960, contextWindowKnown: true });
    expect(probe.models[1]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
      // Servers that report nothing gate tools per-model server-side.
      supportsTools: true,
    });
  });

  it("reads llama.cpp's meta.n_ctx from the model object", async () => {
    const endpoint = await endpointFor("vllm", {
      "/v1/models": { data: [{ id: "glm-flash", meta: { n_ctx: 131072 } }] },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({ contextWindow: 131072, contextWindowKnown: true });
  });

  it("lets a pinned contextLength win over every server-reported window", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": { data: [{ id: "big", max_model_len: 524288 }, { id: "unknown" }] },
      "/props": { default_generation_settings: { n_ctx: 8192 } },
    });

    const probe = await probeEndpoint({ ...endpoint, contextLength: 262144 }, { timeoutMs: 2000 });

    for (const model of probe.models) {
      expect(model).toMatchObject({ contextWindow: 262144, contextWindowKnown: true });
    }
  });
});

describe("probeEndpoint — unreachable", () => {
  it("returns a reason instead of throwing when nothing is listening", async () => {
    const endpoint: LocalEndpoint = {
      id: "ollama",
      label: "Ollama",
      // Port 1 is never a model server.
      baseUrl: "http://127.0.0.1:1/v1",
      kind: "ollama",
    };

    const probe = await probeEndpoint(endpoint, { timeoutMs: 500 });

    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("http://127.0.0.1:1/v1");
    expect(probe.models).toEqual([]);
  });

  it("reports a rejected key distinctly from a dead server", async () => {
    const server = http.createServer((_req, res) => res.writeHead(401).end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const probe = await probeEndpoint(
      {
        id: "lmstudio",
        label: "LM Studio",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        kind: "lmstudio",
        apiKey: "wrong",
      },
      { timeoutMs: 2000 },
    );

    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("rejected the API key");
  });
});

describe("toModelInfo", () => {
  it("produces a registry entry wired to the endpoint credential", () => {
    const info = toModelInfo(
      {
        rawId: "qwen3-coder:30b",
        endpointId: "ollama",
        contextWindow: 262144,
        contextWindowKnown: true,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: true,
      },
      DEFAULT_LOCAL_ENDPOINTS[0]!,
    );

    expect(info).toMatchObject({
      id: "local/ollama/qwen3-coder:30b",
      name: "qwen3-coder:30b (Ollama)",
      provider: "local",
      contextWindow: 262144,
      supportsThinking: true,
      supportsVideo: false,
      authStorageKeys: ["local:ollama"],
      // Ollama accepts reasoning_effort up to "max" (verified on 0.32).
      maxThinkingLevel: "max",
    });
    // Output cap is bounded so a small local window keeps prompt headroom.
    expect(info.maxOutputTokens).toBe(4096);
  });

  it("scales the output cap down on a tiny context window", () => {
    const info = toModelInfo(
      {
        rawId: "tiny",
        endpointId: "llamacpp",
        contextWindow: 4096,
        contextWindowKnown: true,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: false,
      },
      { id: "llamacpp", label: "llama.cpp", baseUrl: "http://x/v1", kind: "llamacpp" },
    );
    expect(info.maxOutputTokens).toBe(1024);
    // Only Ollama documents "max"; the others stop at the universal "high".
    expect(info.maxThinkingLevel).toBe("high");
  });
});

describe("discoverLocalModels", () => {
  it("aggregates reachable endpoints, skips dead ones, and caches", async () => {
    const live = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "live-model" }] },
      "/props": { default_generation_settings: { n_ctx: 32768 } },
    });
    const dead: LocalEndpoint = {
      id: "vllm",
      label: "vLLM",
      baseUrl: "http://127.0.0.1:1/v1",
      kind: "vllm",
    };

    const first = await discoverLocalModels([live, dead], { timeoutMs: 800 });

    expect(first.models.map((m) => m.id)).toEqual(["local/llamacpp/live-model"]);
    expect(first.probes.find((p) => p.endpoint.id === "vllm")?.reachable).toBe(false);

    // Same endpoint set within the TTL returns the identical cached object.
    const second = await discoverLocalModels([live, dead], { timeoutMs: 800 });
    expect(second).toBe(first);

    const forced = await discoverLocalModels([live, dead], { timeoutMs: 800, force: true });
    expect(forced).not.toBe(first);
    expect(forced.models).toHaveLength(1);
  });

  it("finds a probed model's capabilities by full id", async () => {
    const live = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "qwen3:8b" }] },
      "/api/show": { capabilities: ["completion", "tools"], model_info: {} },
    });

    const { probes } = await discoverLocalModels([live], { timeoutMs: 2000 });

    expect(findProbedModel(probes, "local/ollama/qwen3:8b")?.model.supportsTools).toBe(true);
    expect(findProbedModel(probes, "local/ollama/absent")).toBeUndefined();
    expect(findProbedModel(probes, "claude-sonnet-5")).toBeUndefined();
  });
});

describe("probeEndpoint — Authorization", () => {
  async function authSeenBy(apiKey: string | undefined): Promise<string | undefined> {
    let seen: string | undefined = "not called";
    const server = http.createServer((req, res) => {
      seen = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "free-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    await probeEndpoint(
      {
        id: "custom-gw",
        label: "gw",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        kind: "custom",
        ...(apiKey ? { apiKey } : {}),
      },
      { timeoutMs: 2000 },
    );
    return seen;
  }

  it("sends no Authorization header to an endpoint without a key", async () => {
    expect(await authSeenBy(undefined)).toBeUndefined();
  });

  it("sends the endpoint's own key as a bearer token", async () => {
    expect(await authSeenBy("sk-gateway")).toBe("Bearer sk-gateway");
  });
});

describe("localModelShortName", () => {
  it("keeps only the model's own name from a namespaced raw id", () => {
    expect(localModelShortName("minimax/minimax-m2:free")).toBe("minimax-m2:free");
    expect(localModelShortName("hf.co/user/repo:q4")).toBe("repo:q4");
    expect(localModelShortName("qwen3-coder:30b")).toBe("qwen3-coder:30b");
  });
});

describe("probeEndpoint — user-added endpoints", () => {
  it("reads a llama.cpp-style server's context from /props (PolyStrata, Strata)", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": { data: [{ id: "qwen3.6-35b-a3b" }] },
      "/props": { default_generation_settings: { n_ctx: 65536 } },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({ contextWindow: 65536, contextWindowKnown: true });
  });

  it("reads LM Studio's loaded context and drops its embedding models", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": { data: [{ id: "qwen3-coder-30b" }, { id: "text-embedder" }] },
      "/api/v1/models": {
        models: [
          {
            key: "qwen3-coder-30b",
            type: "llm",
            loaded_instances: [{ id: "qwen3-coder-30b", config: { context_length: 32768 } }],
          },
          { key: "text-embedder", type: "embedding", loaded_instances: [] },
        ],
      },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models.map((m) => m.rawId)).toEqual(["qwen3-coder-30b"]);
    expect(probe.models[0]).toMatchObject({ contextWindow: 32768, contextWindowKnown: true });
  });

  it("takes a gateway's context_length without probing further", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": { data: [{ id: "minimax/minimax-m2:free", context_length: 204800 }] },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({ contextWindow: 204800, contextWindowKnown: true });
  });

  it("falls back when the server reports no context anywhere", async () => {
    const endpoint = await endpointFor("custom", { "/v1/models": { data: [{ id: "m" }] } });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("Ollama context sizes", () => {
  it("uses a Modelfile's num_ctx for a model that isn't loaded", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "coder-32k" }] },
      "/api/ps": { models: [] },
      "/api/show": {
        capabilities: ["completion", "tools"],
        parameters: "num_ctx                        32768\ntemperature                    0.6",
      },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({ contextWindow: 32768, contextWindowKnown: true });
  });

  it("leaves an unloaded model without num_ctx unknown", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "qwen3:0.6b" }] },
      "/api/ps": { models: [] },
      "/api/show": { capabilities: ["completion", "tools"], parameters: "temperature 0.6" },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });

  it("loads the model, then reads the size Ollama served it with", async () => {
    const requests: string[] = [];
    let loaded = false;
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/api/generate") loaded = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/api/ps"
            ? { models: loaded ? [{ name: "qwen3:0.6b", context_length: 16384 }] : [] }
            : { done: true, done_reason: "load" },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const endpoint: LocalEndpoint = {
      id: "ollama",
      label: "Ollama",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      kind: "ollama",
    };

    expect(await ollamaServedContext(endpoint, "qwen3:0.6b")).toBeUndefined();
    expect(requests).toEqual(["GET /api/ps"]);
    expect(await ollamaServedContext(endpoint, "qwen3:0.6b", { load: true })).toBe(16384);
    expect(requests.slice(1)).toEqual(["POST /api/generate", "GET /api/ps"]);
  });
});

const sampleModel = {
  rawId: "m",
  endpointId: "ollama",
  contextWindow: 8192,
  contextWindowKnown: false,
  supportsTools: false,
  supportsImages: false,
  supportsThinking: false,
};
const ollamaEp: LocalEndpoint = {
  id: "ollama",
  label: "Ollama",
  baseUrl: "http://x/v1",
  kind: "ollama",
};

describe("parseLocalModelSettings", () => {
  it("accepts valid values and ignores unknown keys", () => {
    const full = {
      contextWindow: 32768,
      maxOutputTokens: 8192,
      temperature: 0.2,
      topP: 1,
      topK: 40,
      repeatPenalty: 1.1,
      seed: -1,
      supportsTools: true,
      extraBody: { a: 1 },
    };
    expect(parseLocalModelSettings({ ...full, bogus: 1 })).toEqual({ settings: full, errors: [] });
    expect(parseLocalModelSettings(null)).toEqual({ settings: {}, errors: [] });
  });

  it("drops out-of-range fields with one sentence each", () => {
    const { settings, errors } = parseLocalModelSettings({
      contextWindow: 100,
      maxOutputTokens: 255,
      temperature: 2.5,
      topP: 1.5,
      topK: 0,
      repeatPenalty: 0,
      seed: -2,
      supportsImages: "yes",
    });
    expect(settings).toEqual({});
    expect(errors).toHaveLength(8);
    expect(errors).toContain("Temperature must be between 0 and 2.");
  });

  it("rejects non-object and oversized extraBody", () => {
    expect(parseLocalModelSettings({ extraBody: [1] }).errors).toHaveLength(1);
    const big = parseLocalModelSettings({ extraBody: { k: "x".repeat(9000) } });
    expect(big.errors).toHaveLength(1);
    expect(big.settings.extraBody).toBeUndefined();
  });
});

describe("parseLocalEndpointSettings", () => {
  it("keeps valid headers and rejects bad names and values", () => {
    const { settings, errors } = parseLocalEndpointSettings({
      headers: {
        "X-Api-Key": "abc",
        Host: "evil",
        "bad name": "v",
        "X-Empty": "",
        "X-Nl": "a\nb",
      },
    });
    expect(settings.headers).toEqual({ "X-Api-Key": "abc" });
    expect(errors).toHaveLength(4);
  });

  it("caps header count and handles empty input", () => {
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`H${i}`, "v"]));
    const { settings, errors } = parseLocalEndpointSettings({ headers });
    expect(errors).toHaveLength(1);
    expect(Object.keys(settings.headers ?? {})).toHaveLength(20);
    expect(parseLocalEndpointSettings(undefined)).toEqual({ settings: {}, errors: [] });
  });
});

describe("applyLocalModelSettings / toModelInfo with settings", () => {
  it("overrides values and records detected ones", () => {
    const out = applyLocalModelSettings(sampleModel, { contextWindow: 32768, supportsTools: true });
    expect(out).toMatchObject({
      contextWindow: 32768,
      contextWindowKnown: true,
      supportsTools: true,
    });
    expect(out.detected).toEqual({
      contextWindow: 8192,
      contextWindowKnown: false,
      supportsTools: false,
      supportsImages: false,
      supportsThinking: false,
    });
    expect(applyLocalModelSettings(sampleModel)).toBe(sampleModel);
  });

  it("caps max output at half the context; default formula unchanged", () => {
    expect(toModelInfo(sampleModel, ollamaEp, { maxOutputTokens: 100_000 }).maxOutputTokens).toBe(
      4096,
    );
    expect(toModelInfo(sampleModel, ollamaEp, { maxOutputTokens: 2000 }).maxOutputTokens).toBe(
      2000,
    );
    expect(toModelInfo(sampleModel, ollamaEp).maxOutputTokens).toBe(2048);
  });

  it("thinking override on a non-Ollama endpoint tops out at high", () => {
    const info = toModelInfo(
      { ...sampleModel, endpointId: "v" },
      { ...ollamaEp, id: "v", kind: "vllm" },
      { supportsThinking: true },
    );
    expect(info.supportsThinking).toBe(true);
    expect(info.maxThinkingLevel).toBe("high");
  });

  it("attaches request body and endpoint headers only when set", () => {
    const info = toModelInfo(
      sampleModel,
      ollamaEp,
      { temperature: 0.2 },
      { headers: { "X-A": "b" } },
    );
    expect(info.requestBody).toEqual({ temperature: 0.2 });
    expect(info.requestHeaders).toEqual({ "X-A": "b" });
    const plain = toModelInfo(sampleModel, ollamaEp);
    expect("requestBody" in plain).toBe(false);
    expect("requestHeaders" in plain).toBe(false);
  });
});

describe("localRequestBody", () => {
  it("typed fields win over extraBody; empty is undefined", () => {
    expect(
      localRequestBody({ temperature: 0.2, topP: 0.9, extraBody: { temperature: 1, foo: "bar" } }),
    ).toEqual({ temperature: 0.2, top_p: 0.9, foo: "bar" });
    expect(localRequestBody({ contextWindow: 4096 })).toBeUndefined();
    expect(localRequestBody(undefined)).toBeUndefined();
  });
});

describe("discoverLocalModels with settings", () => {
  it("applies settings on a cache hit without re-probing", async () => {
    clearLocalDiscoveryCache();
    const live = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "q:1" }] },
      "/api/show": { capabilities: ["completion"] },
    });
    await discoverLocalModels([live], { timeoutMs: 2000 });
    const res = await discoverLocalModels([live], {
      timeoutMs: 2000,
      settings: {
        models: { "local/ollama/q:1": { contextWindow: 32768, temperature: 0.2 } },
        endpoints: { ollama: { headers: { "X-A": "b" } } },
      },
    });
    expect(res.models[0]).toMatchObject({
      contextWindow: 32768,
      requestBody: { temperature: 0.2 },
      requestHeaders: { "X-A": "b" },
    });
    expect(res.probes[0]!.models[0]).toMatchObject({
      contextWindow: 32768,
      contextWindowKnown: true,
    });
    expect(res.probes[0]!.models[0]!.detected?.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe("ollama runtime settings", () => {
  const ollama: LocalEndpoint = {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:1/v1",
    kind: "ollama",
  };

  it("validates the new model fields", () => {
    expect(parseLocalModelSettings({ gpuLayers: 0, batchSize: 512, threads: 8 })).toEqual({
      settings: { gpuLayers: 0, batchSize: 512, threads: 8 },
      errors: [],
    });
    const bad = parseLocalModelSettings({ gpuLayers: 1000, batchSize: 0, threads: 513 });
    expect(bad.settings).toEqual({});
    expect(bad.errors).toHaveLength(3);
  });

  it("validates ollama server settings", () => {
    const ok = parseLocalEndpointSettings({
      ollama: { flashAttention: false, kvCacheType: "q8_0", contextLength: 8192, fit: true },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.settings.ollama).toEqual({
      flashAttention: false,
      kvCacheType: "q8_0",
      contextLength: 8192,
      fit: true,
    });
    const bad = parseLocalEndpointSettings({
      ollama: {
        kvCacheType: "q5",
        contextLength: 10,
        fitTargetMiB: -1,
        cpuMoeLayers: 1000,
        fit: 1,
      },
    });
    expect(bad.settings.ollama).toBeUndefined();
    expect(bad.errors).toHaveLength(5);
  });

  it("maps server settings to env, only those set", () => {
    expect(ollamaServerEnv()).toEqual({});
    expect(ollamaServerEnv({ autoStart: true })).toEqual({});
    expect(
      ollamaServerEnv({
        flashAttention: false,
        kvCacheType: "q4_0",
        contextLength: 4096,
        fit: false,
        fitTargetMiB: 512,
        cpuMoeLayers: 4,
      }),
    ).toEqual({
      OLLAMA_FLASH_ATTENTION: "0",
      OLLAMA_KV_CACHE_TYPE: "q4_0",
      OLLAMA_CONTEXT_LENGTH: "4096",
      LLAMA_ARG_FIT: "off",
      LLAMA_ARG_FIT_TARGET: "512",
      LLAMA_ARG_N_CPU_MOE: "4",
    });
  });

  it("maps model settings to Ollama parameters", () => {
    expect(ollamaModelParameters({ temperature: 0.2 })).toBeUndefined();
    expect(
      ollamaModelParameters({ contextWindow: 32768, gpuLayers: 20, batchSize: 256, threads: 6 }),
    ).toEqual({ num_ctx: 32768, num_gpu: 20, num_batch: 256, num_thread: 6 });
  });

  it("names derived models", () => {
    expect(ollamaDerivedName("qwen3:8b")).toBe("qwen3:8b-israelcode");
    expect(ollamaDerivedName("qwen3")).toBe("qwen3:latest-israelcode");
    expect(ollamaDerivedName("host:5000/lib/qwen3")).toBe("host:5000/lib/qwen3:latest-israelcode");
    expect(isOllamaDerivedName("qwen3:8b-israelcode")).toBe(true);
    expect(isOllamaDerivedName("qwen3:8b")).toBe(false);
  });

  it("toModelInfo sends the derived model only for Ollama with parameters", () => {
    const model = {
      rawId: "qwen3:8b",
      endpointId: "ollama",
      contextWindow: 4096,
      contextWindowKnown: false,
      supportsTools: true,
      supportsImages: false,
      supportsThinking: false,
    };
    expect(toModelInfo(model, ollama, { gpuLayers: 10 }).requestModel).toBe(
      "local/ollama/qwen3:8b-israelcode",
    );
    expect(toModelInfo(model, ollama, { temperature: 0.1 }).requestModel).toBeUndefined();
    expect(
      toModelInfo(model, { ...ollama, kind: "custom" }, { gpuLayers: 10 }).requestModel,
    ).toBeUndefined();
  });

  it("hides derived models and creates/deletes them over the API", async () => {
    const seen: { method?: string; url?: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        if (req.url === "/v1/models") {
          res
            .writeHead(200)
            .end(JSON.stringify({ data: [{ id: "a:1" }, { id: "a:1-israelcode" }] }));
        } else if (req.url === "/api/create" && body.includes('"bad:1"')) {
          res.writeHead(500).end(JSON.stringify({ error: "boom" }));
        } else if (req.url === "/api/delete") res.writeHead(404).end("{}");
        else res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const endpoint = { ...ollama, baseUrl };
      const probe = await probeEndpoint(endpoint);
      expect(probe.models.map((m) => m.rawId)).toEqual(["a:1"]);
      await expect(ensureOllamaDerivedModel(endpoint, "a:1", { num_gpu: 3 })).resolves.toBe(
        "a:1-israelcode",
      );
      expect(JSON.parse(seen.find((s) => s.url === "/api/create")!.body)).toEqual({
        model: "a:1-israelcode",
        from: "a:1",
        parameters: { num_gpu: 3 },
        stream: false,
      });
      await expect(ensureOllamaDerivedModel(endpoint, "bad:1", { num_gpu: 3 })).rejects.toThrow(
        "boom",
      );
      await expect(deleteOllamaDerivedModel(endpoint, "a:1")).resolves.toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
