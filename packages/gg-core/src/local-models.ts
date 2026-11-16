/**
 * Local model discovery — Ollama, LM Studio, llama.cpp (`llama-server`), vLLM,
 * and any other OpenAI-compatible server the user points us at.
 *
 * Everything rides the OpenAI-compatible `/v1` transport (see the `local`
 * provider in gg-ai's stream.ts); the only per-server difference is where the
 * *capabilities* come from, because `GET /v1/models` reports nothing useful:
 *
 *   - Ollama    → `/api/show` + `/api/ps` → capabilities + running context
 *   - LM Studio → `/api/v1/models` (v0 fallback) → capabilities + loaded context
 *   - llama.cpp → `GET /props`          → `default_generation_settings.n_ctx`
 *   - vLLM/other → nothing; `max_model_len`, `context_length` or `meta.n_ctx`
 *                  sometimes rides the model object.
 *
 * A custom endpoint may pin `contextLength`, which wins over all of the above.
 *
 * Probing never throws: an unreachable server is a normal state (the user just
 * doesn't have it running), not an error to surface.
 */
import { LOCAL_NO_API_KEY, localBearerKey } from "@kenkaiiii/gg-ai";
import type { ModelInfo } from "./model-registry.js";
import { log } from "./logger.js";

// ── Types ──────────────────────────────────────────────────

/** Which capability API a local endpoint speaks, beyond plain `/v1/models`. */
export type LocalEndpointKind = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "custom";

export interface LocalEndpoint {
  /** Stable slug, used in model ids (`local/<id>/<rawId>`) and auth keys (`local:<id>`). */
  id: string;
  label: string;
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseUrl: string;
  kind: LocalEndpointKind;
  /** Optional bearer token (LM Studio 0.4+ can require one). */
  apiKey?: string;
  /** True for endpoints the user added by hand (removable). */
  custom?: boolean;
  /** User-pinned context window; wins over whatever the server reports. */
  contextLength?: number;
}

/** One model as reported (and enriched) by a local server. */
export interface LocalModel {
  /** Model id on the wire, exactly as the server names it (e.g. `qwen3-coder:30b`). */
  rawId: string;
  endpointId: string;
  contextWindow: number;
  /** True when the server told us the real window; false means we guessed. */
  contextWindowKnown: boolean;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  /** LM Studio only: whether the model is currently resident in memory. */
  loaded?: boolean;
  /** Probed values before user overrides; set by `applyLocalModelSettings`. */
  detected?: Pick<
    LocalModel,
    "contextWindow" | "contextWindowKnown" | "supportsTools" | "supportsImages" | "supportsThinking"
  >;
}

export interface LocalModelSettings {
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  seed?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  extraBody?: Record<string, unknown>;
  /** Ollama only → `num_gpu`. Absent = Ollama fits layers automatically. */
  gpuLayers?: number;
  /** Ollama only → `num_batch`. */
  batchSize?: number;
  /** Ollama only → `num_thread`. */
  threads?: number;
}

export interface OllamaServerSettings {
  flashAttention?: boolean;
  kvCacheType?: "f16" | "q8_0" | "q4_0";
  contextLength?: number;
  fit?: boolean;
  fitTargetMiB?: number;
  cpuMoeLayers?: number;
  autoStart?: boolean;
}

export interface LocalEndpointSettings {
  headers?: Record<string, string>;
  ollama?: OllamaServerSettings;
}

export interface LocalSettings {
  models: Record<string, LocalModelSettings>;
  endpoints: Record<string, LocalEndpointSettings>;
}

export interface LocalEndpointProbe {
  endpoint: LocalEndpoint;
  reachable: boolean;
  /** Human-readable reason when `reachable` is false (never a raw stack). */
  reason?: string;
  models: LocalModel[];
}

// ── Defaults ───────────────────────────────────────────────

/**
 * The server we look for without being asked. LM Studio, llama.cpp and vLLM
 * are no longer auto-probed — one honest row beats four mostly-dead ones;
 * anything else is one "Add endpoint" away (custom kind keeps working).
 */
export const DEFAULT_LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", kind: "ollama" },
];

/**
 * Context window assumed when a server tells us nothing. Deliberately
 * conservative: over-guessing means the provider 400s mid-run at a point
 * auto-compaction already sailed past, while under-guessing only compacts early.
 */
// Matches Ollama's smallest documented default; still a guess, not an allocation.
export const FALLBACK_CONTEXT_WINDOW = 4096;

/** Token stored for endpoints with no key; never sent on the wire. */
export const LOCAL_API_KEY_PLACEHOLDER = LOCAL_NO_API_KEY;

const DEFAULT_PROBE_TIMEOUT_MS = 1200;
// Ollama can take seconds to list a large or busy model store; refused connections still fail at once.
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
/** Capability lookups are per-model; cap the fan-out so 40 Ollama models don't stampede. */
const ENRICH_CONCURRENCY = 6;
const CACHE_TTL_MS = 30_000;

/** Ids that are embedding/rerank models, not chat models — they can't drive an agent. */
const NON_CHAT_ID_PATTERN = /(?:^|[-_/])(?:embed|embedding|rerank|reranker|bge|nomic-embed)/i;

// ── Model id scheme ────────────────────────────────────────

const LOCAL_ID_PREFIX = "local/";

/**
 * `local/<endpointId>/<rawModelId>`. The raw id can itself contain slashes
 * (`hf.co/user/repo:q4`), so only the first two segments are structural.
 */
export function formatLocalModelId(endpointId: string, rawId: string): string {
  return `${LOCAL_ID_PREFIX}${endpointId}/${rawId}`;
}

export function parseLocalModelId(id: string): { endpointId: string; rawId: string } | undefined {
  if (!id.startsWith(LOCAL_ID_PREFIX)) return undefined;
  const rest = id.slice(LOCAL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { endpointId: rest.slice(0, slash), rawId: rest.slice(slash + 1) };
}

/**
 * The model's own name, for a UI that shows the endpoint separately: the last
 * segment of the raw id, so `minimax/minimax-m2:free` reads `minimax-m2:free`.
 */
export function localModelShortName(rawId: string): string {
  return rawId.slice(rawId.lastIndexOf("/") + 1) || rawId;
}

export function isLocalModelId(id: string): boolean {
  return parseLocalModelId(id) !== undefined;
}

/** Auth-storage key holding the credential (and baseUrl) for one local endpoint. */
export function localAuthStorageKey(endpointId: string): string {
  return `local:${endpointId}`;
}

// ── HTTP helpers ───────────────────────────────────────────

/** Base URL with any trailing `/v1` (and trailing slashes) removed — the server root. */
export function endpointRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function authHeaders(endpoint: LocalEndpoint): Record<string, string> {
  const key = localBearerKey(endpoint.apiKey);
  return {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    Accept: "application/json",
  };
}

interface FetchJsonOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: unknown;
}

/** GET/POST JSON with a hard timeout. Returns `undefined` on any failure. */
async function fetchJson<T>(
  url: string,
  endpoint: LocalEndpoint,
  options: FetchJsonOptions,
): Promise<T | undefined> {
  try {
    const res = await fetchJsonOrThrow<T>(url, endpoint, options);
    return res;
  } catch {
    return undefined;
  }
}

async function fetchJsonOrThrow<T>(
  url: string,
  endpoint: LocalEndpoint,
  { timeoutMs, signal, method = "GET", body }: FetchJsonOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body
        ? { ...authHeaders(endpoint), "Content-Type": "application/json" }
        : authHeaders(endpoint),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Turn a fetch failure into wording a user can act on. */
function unreachableReason(endpoint: LocalEndpoint, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) return `No response from ${endpoint.baseUrl} (timed out)`;
  if (/HTTP 401|HTTP 403/.test(message)) {
    return `${endpoint.baseUrl} rejected the API key (HTTP ${message.includes("401") ? 401 : 403})`;
  }
  if (/HTTP \d+/.test(message)) return `${endpoint.baseUrl} returned ${message}`;
  return `Not running at ${endpoint.baseUrl}`;
}

// ── Server response shapes ─────────────────────────────────

interface OpenAIModelListEntry {
  id?: string;
  /** vLLM sometimes reports the real window here. */
  max_model_len?: number;
  /** OpenRouter-style gateways report it here. */
  context_length?: number;
  /** llama.cpp-derived servers report the loaded allocation here. */
  meta?: { n_ctx?: number };
}
interface OpenAIModelList {
  data?: OpenAIModelListEntry[];
}

interface OllamaShowResponse {
  capabilities?: string[];
  /** Modelfile PARAMETER lines, e.g. "num_ctx    32768\ntemperature 0.6". */
  parameters?: string;
}
interface OllamaRunningModels {
  models?: { name?: string; model?: string; context_length?: number }[];
}

interface LmStudioV1ModelList {
  models?: {
    key?: string;
    type?: string;
    capabilities?: { vision?: boolean };
    loaded_instances?: { id?: string; config?: { context_length?: number } }[];
  }[];
}

interface LmStudioModelEntry {
  id?: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}
interface LmStudioModelList {
  data?: LmStudioModelEntry[];
}

interface LlamaCppProps {
  default_generation_settings?: { n_ctx?: number };
}

// ── Probing ────────────────────────────────────────────────

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ask one endpoint what it serves. Never throws — an unreachable server yields
 * `{ reachable: false, reason }` so the UI can say "not running" without an
 * error toast.
 */
export async function probeEndpoint(
  endpoint: LocalEndpoint,
  { timeoutMs, signal }: ProbeOptions = {},
): Promise<LocalEndpointProbe> {
  const listUrl = `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
  let list: OpenAIModelList;
  try {
    list = await fetchJsonOrThrow<OpenAIModelList>(listUrl, endpoint, {
      timeoutMs: timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    return { endpoint, reachable: false, reason: unreachableReason(endpoint, err), models: [] };
  }

  const entries = (list.data ?? []).filter(
    (entry): entry is OpenAIModelListEntry & { id: string } =>
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      !NON_CHAT_ID_PATTERN.test(entry.id) &&
      !(endpoint.kind === "ollama" && isOllamaDerivedName(entry.id)),
  );

  const enriched = await enrich(endpoint, entries, {
    timeoutMs: timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    signal,
  });
  const pinned = contextLength(endpoint.contextLength);
  const models =
    pinned === undefined
      ? enriched
      : enriched.map((m) => ({ ...m, contextWindow: pinned, contextWindowKnown: true }));
  log("INFO", "local-models", `Probed ${endpoint.label}`, {
    baseUrl: endpoint.baseUrl,
    models: String(models.length),
  });
  return { endpoint, reachable: true, models };
}

async function enrich(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  if (endpoint.kind === "lmstudio") return enrichLmStudio(endpoint, entries, options);
  if (endpoint.kind === "ollama") return enrichOllama(endpoint, entries, options);
  if (endpoint.kind === "llamacpp") return enrichLlamaCpp(endpoint, entries, options);
  if (endpoint.kind === "custom") return enrichCustom(endpoint, entries, options);
  return entries.map((entry) => genericModel(endpoint, entry));
}

/**
 * A user-added endpoint is often LM Studio or a llama.cpp-style server (PolyStrata,
 * Strata) on a port we don't auto-probe. Their OpenAI model list carries no context
 * size, which would leave every model on the 4K fallback, so ask the server's own
 * API the way the built-in kinds do. Gateways that report sizes skip both lookups.
 */
async function enrichCustom(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const generic = entries.map((entry) => genericModel(endpoint, entry));
  if (generic.every((model) => model.contextWindowKnown)) return generic;
  const root = endpointRoot(endpoint.baseUrl);
  const props = await fetchJson<LlamaCppProps>(`${root}/props`, endpoint, options);
  const nCtx = contextLength(props?.default_generation_settings?.n_ctx);
  if (nCtx !== undefined) return llamaCppModels(endpoint, entries, nCtx);
  const lmStudio = await fetchJson<LmStudioV1ModelList>(`${root}/api/v1/models`, endpoint, options);
  if (Array.isArray(lmStudio?.models)) return enrichLmStudio(endpoint, entries, options, lmStudio);
  return generic;
}

/**
 * Servers that report no capabilities (vLLM, generic gateways) gate tool calling
 * per-model server-side. Assuming tools work is the useful default: a model that
 * genuinely can't will surface a normal provider error on the first tool call,
 * whereas assuming it can't makes every such model unusable.
 */
function genericModel(
  endpoint: LocalEndpoint,
  entry: OpenAIModelListEntry & { id: string },
): LocalModel {
  const declared =
    contextLength(entry.max_model_len) ??
    contextLength(entry.context_length) ??
    contextLength(entry.meta?.n_ctx);
  return {
    rawId: entry.id,
    endpointId: endpoint.id,
    contextWindow: declared ?? FALLBACK_CONTEXT_WINDOW,
    contextWindowKnown: declared !== undefined,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
  };
}

async function enrichOllama(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const showUrl = `${endpointRoot(endpoint.baseUrl)}/api/show`;
  const running = await fetchJson<OllamaRunningModels>(
    `${endpointRoot(endpoint.baseUrl)}/api/ps`,
    endpoint,
    options,
  );
  const runningModels = Array.isArray(running?.models) ? running.models : [];
  const enriched = await mapLimited(entries, ENRICH_CONCURRENCY, async (entry) => {
    const show = await fetchJson<OllamaShowResponse>(showUrl, endpoint, {
      ...options,
      method: "POST",
      body: { model: entry.id },
    });
    const caps = Array.isArray(show?.capabilities) ? show.capabilities : [];
    // Capabilities are authoritative for "is this a chat model at all". Names
    // like `all-minilm` carry no hint, so filtering on the id alone leaves
    // embedding models in the picker as dead, tool-less rows.
    if (caps.includes("embedding") && !caps.includes("completion")) return undefined;
    // Ollama's OpenAI endpoint serves the loaded size, else the Modelfile's
    // num_ctx, else its own default (which only a load reveals).
    const ctx = runningContext(runningModels, entry.id) ?? modelfileNumCtx(show?.parameters);
    return {
      rawId: entry.id,
      endpointId: endpoint.id,
      contextWindow: ctx ?? FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: ctx !== undefined,
      // Ollama reports capabilities honestly, so trust it here rather than
      // using the optimistic generic default.
      supportsTools: show ? caps.includes("tools") : true,
      supportsImages: caps.includes("vision"),
      supportsThinking: caps.includes("thinking"),
    };
  });
  return enriched.filter((model): model is LocalModel => model !== undefined);
}

function runningContext(
  models: NonNullable<OllamaRunningModels["models"]>,
  rawId: string,
): number | undefined {
  return contextLength(
    models.find((model) => model?.name === rawId || model?.model === rawId)?.context_length,
  );
}

function modelfileNumCtx(parameters: string | undefined): number | undefined {
  const match = /^num_ctx\s+(\d+)\s*$/m.exec(parameters ?? "");
  return match ? contextLength(Number(match[1])) : undefined;
}

/**
 * The context Ollama serves `rawId` with, read from `/api/ps`. With `load`, first
 * loads the model the way a chat request would (default options), since an
 * unloaded model's size is only decided at load time: the OpenAI endpoint
 * ignores `num_ctx`, so this is the window the agent will really get.
 */
export async function ollamaServedContext(
  endpoint: LocalEndpoint,
  rawId: string,
  {
    load = false,
    timeoutMs = 120_000,
    signal,
  }: { load?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<number | undefined> {
  const root = endpointRoot(endpoint.baseUrl);
  if (load) {
    // An empty generate request only loads the model.
    await fetchJson(`${root}/api/generate`, endpoint, {
      timeoutMs,
      signal,
      method: "POST",
      body: { model: rawId },
    });
  }
  const running = await fetchJson<OllamaRunningModels>(`${root}/api/ps`, endpoint, {
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    signal,
  });
  return runningContext(Array.isArray(running?.models) ? running.models : [], rawId);
}

/** Never let malformed server metadata become a request or compaction budget. */
function contextLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function enrichLmStudio(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
  fetched?: LmStudioV1ModelList,
): Promise<LocalModel[]> {
  const root = endpointRoot(endpoint.baseUrl);
  const detail =
    fetched ?? (await fetchJson<LmStudioV1ModelList>(`${root}/api/v1/models`, endpoint, options));
  const byId = new Map<string, LmStudioModelEntry>();
  if (Array.isArray(detail?.models)) {
    for (const model of detail.models) {
      if (typeof model?.key !== "string") continue;
      const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
      const contexts = instances.map((instance) => contextLength(instance?.config?.context_length));
      // A model key may route to any loaded instance; use the smallest allocation.
      const ctx =
        contexts.length && contexts.every((value) => value !== undefined)
          ? contexts.reduce((min, value) => Math.min(min, value))
          : undefined;
      const info: LmStudioModelEntry = {
        id: model.key,
        type: model.type === "llm" && model.capabilities?.vision === true ? "vlm" : model.type,
        state: instances.length ? "loaded" : "not-loaded",
        loaded_context_length: ctx,
      };
      byId.set(model.key, info);
      for (const instance of instances) {
        if (typeof instance?.id === "string" && instance.id !== model.key) {
          byId.set(instance.id, {
            ...info,
            id: instance.id,
            loaded_context_length: contextLength(instance.config?.context_length),
          });
        }
      }
    }
  } else {
    const legacy = await fetchJson<LmStudioModelList>(`${root}/api/v0/models`, endpoint, options);
    if (Array.isArray(legacy?.data)) {
      for (const model of legacy.data) {
        if (typeof model?.id === "string") byId.set(model.id, model);
      }
    }
  }
  const models: LocalModel[] = [];
  for (const entry of entries) {
    const info = byId.get(entry.id);
    // `type` is authoritative here: embeddings models are listed by
    // /v1/models too and would otherwise show up as selectable chat models.
    if (info && info.type !== "llm" && info.type !== "vlm") continue;
    const ctx = info?.state === "loaded" ? contextLength(info.loaded_context_length) : undefined;
    models.push({
      rawId: entry.id,
      endpointId: endpoint.id,
      contextWindow: ctx ?? FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: ctx !== undefined,
      // LM Studio doesn't report tool support; it gates per-model at request time.
      supportsTools: true,
      supportsImages: info?.type === "vlm",
      supportsThinking: false,
      loaded: info?.state === "loaded",
    });
  }
  return models;
}

async function enrichLlamaCpp(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const props = await fetchJson<LlamaCppProps>(
    `${endpointRoot(endpoint.baseUrl)}/props`,
    endpoint,
    options,
  );
  return llamaCppModels(
    endpoint,
    entries,
    contextLength(props?.default_generation_settings?.n_ctx),
  );
}

function llamaCppModels(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  nCtx: number | undefined,
): LocalModel[] {
  return entries.map((entry) => ({
    ...genericModel(endpoint, entry),
    contextWindow: nCtx ?? FALLBACK_CONTEXT_WINDOW,
    contextWindowKnown: nCtx !== undefined,
  }));
}

/** Bounded-parallel map — keeps input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── ModelInfo mapping ──────────────────────────────────────

/**
 * Highest reasoning effort an endpoint accepts. Ollama documents (and 0.32
 * verifiably accepts) `low|medium|high|max|none` on `reasoning_effort`; the
 * other OpenAI-compatible servers only define `low|medium|high`, so they stop
 * at `high` rather than risking a 400 mid-run on an effort they never declared.
 * No local server accepts `xhigh`.
 */
function maxThinkingLevelFor(endpoint: LocalEndpoint): "high" | "max" {
  return endpoint.kind === "ollama" ? "max" : "high";
}

const MAX_EXTRA_BODY_LENGTH = 8192;
const MAX_HEADERS = 20;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type NumericSetting =
  | "contextWindow"
  | "maxOutputTokens"
  | "temperature"
  | "topP"
  | "topK"
  | "repeatPenalty"
  | "seed"
  | "gpuLayers"
  | "batchSize"
  | "threads";

/** Validate user-entered model settings; bad fields are dropped with one sentence each. */
export function parseLocalModelSettings(raw: unknown): {
  settings: LocalModelSettings;
  errors: string[];
} {
  const settings: LocalModelSettings = {};
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { settings, errors };
  if (!isPlainObject(raw)) return { settings, errors: ["Settings must be an object."] };

  const num = (key: NumericSetting, label: string, ok: (n: number) => boolean, rule: string) => {
    const value = raw[key];
    if (value === undefined || value === null) return;
    if (typeof value === "number" && Number.isFinite(value) && ok(value)) settings[key] = value;
    else errors.push(`${label} must be ${rule}.`);
  };
  const int = (n: number) => Number.isSafeInteger(n);
  num(
    "contextWindow",
    "Context window",
    (n) => int(n) && n >= 1024 && n <= 4_000_000,
    "a whole number between 1024 and 4000000",
  );
  num(
    "maxOutputTokens",
    "Max output",
    (n) => int(n) && n >= 256 && n <= 1_000_000,
    "a whole number between 256 and 1000000",
  );
  num("temperature", "Temperature", (n) => n >= 0 && n <= 2, "between 0 and 2");
  num("topP", "Top P", (n) => n >= 0 && n <= 1, "between 0 and 1");
  num("topK", "Top K", (n) => int(n) && n >= 1 && n <= 1000, "a whole number between 1 and 1000");
  num("repeatPenalty", "Repeat penalty", (n) => n > 0 && n <= 3, "greater than 0 and at most 3");
  num(
    "seed",
    "Seed",
    (n) => int(n) && n >= -1 && n <= 2_147_483_647,
    "a whole number between -1 and 2147483647",
  );
  num(
    "gpuLayers",
    "GPU layers",
    (n) => int(n) && n >= 0 && n <= 999,
    "a whole number between 0 and 999",
  );
  num(
    "batchSize",
    "Batch size",
    (n) => int(n) && n >= 1 && n <= 8192,
    "a whole number between 1 and 8192",
  );
  num(
    "threads",
    "CPU threads",
    (n) => int(n) && n >= 1 && n <= 512,
    "a whole number between 1 and 512",
  );

  for (const [key, label] of [
    ["supportsTools", "Tool support"],
    ["supportsImages", "Image support"],
    ["supportsThinking", "Thinking support"],
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") settings[key] = value;
    else errors.push(`${label} must be true or false.`);
  }

  const extra = raw.extraBody;
  if (extra !== undefined && extra !== null) {
    if (!isPlainObject(extra)) errors.push("Extra body must be a JSON object.");
    else if (JSON.stringify(extra).length > MAX_EXTRA_BODY_LENGTH) {
      errors.push(`Extra body must be at most ${MAX_EXTRA_BODY_LENGTH} characters of JSON.`);
    } else settings.extraBody = extra;
  }
  return { settings, errors };
}

/** Validate per-endpoint request headers and Ollama server settings. */
export function parseLocalEndpointSettings(raw: unknown): {
  settings: LocalEndpointSettings;
  errors: string[];
} {
  const settings: LocalEndpointSettings = {};
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { settings, errors };
  if (!isPlainObject(raw)) return { settings, errors: ["Settings must be an object."] };
  const rawHeaders = raw.headers;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (!isPlainObject(rawHeaders)) {
      errors.push("Headers must be an object of names and values.");
    } else {
      const entries = Object.entries(rawHeaders);
      if (entries.length > MAX_HEADERS) {
        errors.push(`At most ${MAX_HEADERS} headers are allowed.`);
        entries.length = MAX_HEADERS;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
          errors.push(`Header name "${name}" must be 1-64 letters, digits or hyphens.`);
        } else if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          errors.push(`Header "${name}" cannot be set.`);
        } else if (
          typeof value !== "string" ||
          value.length < 1 ||
          value.length > 4096 ||
          /[\r\n]/.test(value)
        ) {
          errors.push(`Header "${name}" must have a value of 1-4096 characters on a single line.`);
        } else headers[name] = value;
      }
      if (Object.keys(headers).length > 0) settings.headers = headers;
    }
  }
  if (raw.ollama !== undefined && raw.ollama !== null) {
    const parsed = parseOllamaServerSettings(raw.ollama, errors);
    if (Object.keys(parsed).length > 0) settings.ollama = parsed;
  }
  return { settings, errors };
}

function parseOllamaServerSettings(raw: unknown, errors: string[]): OllamaServerSettings {
  const out: OllamaServerSettings = {};
  if (!isPlainObject(raw)) {
    errors.push("Ollama settings must be an object.");
    return out;
  }
  for (const [key, label] of [
    ["flashAttention", "Flash attention"],
    ["fit", "Automatic memory fitting"],
    ["autoStart", "Auto-start"],
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") out[key] = value;
    else errors.push(`${label} must be true or false.`);
  }
  const kv = raw.kvCacheType;
  if (kv !== undefined && kv !== null) {
    if (kv === "f16" || kv === "q8_0" || kv === "q4_0") out.kvCacheType = kv;
    else errors.push("KV cache type must be f16, q8_0 or q4_0.");
  }
  for (const [key, label, min, max] of [
    ["contextLength", "Server context length", 1024, 4_000_000],
    ["fitTargetMiB", "Fit target", 0, 1_000_000],
    ["cpuMoeLayers", "CPU MoE layers", 0, 999],
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max) {
      out[key] = value;
    } else errors.push(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return out;
}

/** Environment for `ollama serve`; only the fields the user set. */
export function ollamaServerEnv(s?: OllamaServerSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (!s) return env;
  if (s.flashAttention !== undefined) env.OLLAMA_FLASH_ATTENTION = s.flashAttention ? "1" : "0";
  if (s.kvCacheType !== undefined) env.OLLAMA_KV_CACHE_TYPE = s.kvCacheType;
  if (s.contextLength !== undefined) env.OLLAMA_CONTEXT_LENGTH = String(s.contextLength);
  if (s.fit !== undefined) env.LLAMA_ARG_FIT = s.fit ? "on" : "off";
  if (s.fitTargetMiB !== undefined) env.LLAMA_ARG_FIT_TARGET = String(s.fitTargetMiB);
  if (s.cpuMoeLayers !== undefined) env.LLAMA_ARG_N_CPU_MOE = String(s.cpuMoeLayers);
  return env;
}

/** Per-model options Ollama's /v1 cannot carry; they go into a derived model. */
export function ollamaModelParameters(s?: LocalModelSettings): Record<string, number> | undefined {
  if (!s) return undefined;
  const params: Record<string, number> = {};
  if (s.contextWindow !== undefined) params.num_ctx = s.contextWindow;
  if (s.gpuLayers !== undefined) params.num_gpu = s.gpuLayers;
  if (s.batchSize !== undefined) params.num_batch = s.batchSize;
  if (s.threads !== undefined) params.num_thread = s.threads;
  return Object.keys(params).length > 0 ? params : undefined;
}

export const OLLAMA_DERIVED_SUFFIX = "-israelcode";

function hasOllamaTag(rawId: string): boolean {
  return rawId.lastIndexOf(":") > rawId.lastIndexOf("/");
}

export function ollamaDerivedName(rawId: string): string {
  return hasOllamaTag(rawId)
    ? `${rawId}${OLLAMA_DERIVED_SUFFIX}`
    : `${rawId}:latest${OLLAMA_DERIVED_SUFFIX}`;
}

export function isOllamaDerivedName(rawId: string): boolean {
  return hasOllamaTag(rawId) && rawId.endsWith(OLLAMA_DERIVED_SUFFIX);
}

async function ollamaRequest(
  endpoint: LocalEndpoint,
  path: string,
  method: "POST" | "DELETE",
  body: unknown,
  { timeoutMs = 120_000, signal }: ProbeOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(`${endpointRoot(endpoint.baseUrl)}${path}`, {
      method,
      signal: controller.signal,
      headers: { ...authHeaders(endpoint), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(unreachableReason(endpoint, err), { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function ollamaErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  } catch {
    // not JSON
  }
  return text.trim() || `HTTP ${res.status}`;
}

/** Create (or replace) the derived model carrying `parameters`; resolves its name. */
export async function ensureOllamaDerivedModel(
  endpoint: LocalEndpoint,
  rawId: string,
  parameters: Record<string, number>,
  opts: ProbeOptions = {},
): Promise<string> {
  const derived = ollamaDerivedName(rawId);
  const res = await ollamaRequest(
    endpoint,
    "/api/create",
    "POST",
    { model: derived, from: rawId, parameters, stream: false },
    opts,
  );
  if (!res.ok) throw new Error(await ollamaErrorText(res));
  return derived;
}

export async function deleteOllamaDerivedModel(
  endpoint: LocalEndpoint,
  rawId: string,
  opts: ProbeOptions = {},
): Promise<void> {
  const res = await ollamaRequest(
    endpoint,
    "/api/delete",
    "DELETE",
    { model: ollamaDerivedName(rawId) },
    opts,
  );
  if (!res.ok && res.status !== 404) throw new Error(await ollamaErrorText(res));
}

/** Override detected values with the user's; `detected` keeps the probed ones. */
export function applyLocalModelSettings(
  model: LocalModel,
  settings?: LocalModelSettings,
): LocalModel {
  if (!settings) return model;
  const detected = model.detected ?? {
    contextWindow: model.contextWindow,
    contextWindowKnown: model.contextWindowKnown,
    supportsTools: model.supportsTools,
    supportsImages: model.supportsImages,
    supportsThinking: model.supportsThinking,
  };
  return {
    ...model,
    detected,
    ...(settings.contextWindow !== undefined
      ? { contextWindow: settings.contextWindow, contextWindowKnown: true }
      : {}),
    ...(settings.supportsTools !== undefined ? { supportsTools: settings.supportsTools } : {}),
    ...(settings.supportsImages !== undefined ? { supportsImages: settings.supportsImages } : {}),
    ...(settings.supportsThinking !== undefined
      ? { supportsThinking: settings.supportsThinking }
      : {}),
  };
}

/** Request-body fields for a local model; typed fields win over extraBody. */
export function localRequestBody(
  settings?: LocalModelSettings,
): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  const typed: Record<string, unknown> = {
    temperature: settings.temperature,
    top_p: settings.topP,
    top_k: settings.topK,
    repeat_penalty: settings.repeatPenalty,
    seed: settings.seed,
  };
  const body: Record<string, unknown> = { ...settings.extraBody };
  for (const [key, value] of Object.entries(typed)) if (value !== undefined) body[key] = value;
  return Object.keys(body).length > 0 ? body : undefined;
}

/** Convert a probed local model into the registry shape the whole app speaks. */
export function toModelInfo(
  model: LocalModel,
  endpoint: LocalEndpoint,
  settings?: LocalModelSettings,
  endpointSettings?: LocalEndpointSettings,
): ModelInfo {
  const effective = applyLocalModelSettings(model, settings);
  const headers = endpointSettings?.headers;
  const requestBody = localRequestBody(settings);
  const derived =
    endpoint.kind === "ollama" && ollamaModelParameters(settings)
      ? formatLocalModelId(effective.endpointId, ollamaDerivedName(effective.rawId))
      : undefined;
  return {
    id: formatLocalModelId(effective.endpointId, effective.rawId),
    name: `${effective.rawId} (${endpoint.label})`,
    provider: "local",
    contextWindow: effective.contextWindow,
    // Leave real headroom for the prompt on small local windows.
    maxOutputTokens:
      settings?.maxOutputTokens !== undefined
        ? Math.min(settings.maxOutputTokens, Math.max(512, Math.floor(effective.contextWindow / 2)))
        : Math.max(512, Math.min(4096, Math.floor(effective.contextWindow / 4))),
    supportsThinking: effective.supportsThinking,
    supportsImages: effective.supportsImages,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: maxThinkingLevelFor(endpoint),
    authStorageKeys: [localAuthStorageKey(effective.endpointId)],
    ...(requestBody ? { requestBody } : {}),
    ...(derived ? { requestModel: derived } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { requestHeaders: headers } : {}),
  };
}

// ── Discovery ──────────────────────────────────────────────

export interface DiscoveryResult {
  probes: LocalEndpointProbe[];
  models: ModelInfo[];
}

interface CacheEntry {
  key: string;
  at: number;
  result: DiscoveryResult;
}

let cache: CacheEntry | undefined;

function cacheKey(endpoints: readonly LocalEndpoint[]): string {
  return endpoints.map((e) => `${e.id}@${e.baseUrl}#${e.contextLength ?? ""}`).join("|");
}

export interface DiscoverOptions extends ProbeOptions {
  /** Skip the 30s cache (the UI's "Scan" button). */
  force?: boolean;
  /** Applied after the probe cache, so a settings change needs no re-probe. */
  settings?: LocalSettings;
}

/**
 * Probe every endpoint in parallel and return both the per-endpoint status (for
 * the UI) and the `ModelInfo[]` ready for `registerRuntimeModels()`. Results are
 * cached for 30s per endpoint set so repeated `GET /models` calls don't re-probe
 * four servers; `force` bypasses it after an `ollama pull`.
 */
export async function discoverLocalModels(
  endpoints: readonly LocalEndpoint[] = DEFAULT_LOCAL_ENDPOINTS,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const key = cacheKey(endpoints);
  let raw: DiscoveryResult;
  if (!options.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    raw = cache.result;
  } else {
    const probes = await Promise.all(endpoints.map((endpoint) => probeEndpoint(endpoint, options)));
    const models = probes.flatMap((probe) =>
      probe.models.map((model) => toModelInfo(model, probe.endpoint)),
    );
    raw = { probes, models };
    cache = { key, at: Date.now(), result: raw };
  }
  const { settings } = options;
  if (!settings) return raw;
  const modelSettings = (model: LocalModel) =>
    settings.models[formatLocalModelId(model.endpointId, model.rawId)];
  const models = raw.probes.flatMap((probe) =>
    probe.models.map((model) =>
      toModelInfo(
        model,
        probe.endpoint,
        modelSettings(model),
        settings.endpoints[probe.endpoint.id],
      ),
    ),
  );
  const probes = raw.probes.map((probe) => ({
    ...probe,
    models: probe.models.map((model) => applyLocalModelSettings(model, modelSettings(model))),
  }));
  return { probes, models };
}

/** Drop the discovery cache (used by tests and after an endpoint is added/removed). */
export function clearLocalDiscoveryCache(): void {
  cache = undefined;
}

/** Look up the probed capabilities of a discovered model, by full local id. */
export function findProbedModel(
  probes: readonly LocalEndpointProbe[],
  modelId: string,
): { model: LocalModel; endpoint: LocalEndpoint } | undefined {
  const parsed = parseLocalModelId(modelId);
  if (!parsed) return undefined;
  for (const probe of probes) {
    if (probe.endpoint.id !== parsed.endpointId) continue;
    const model = probe.models.find((m) => m.rawId === parsed.rawId);
    if (model) return { model, endpoint: probe.endpoint };
  }
  return undefined;
}
