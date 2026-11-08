import fs from "node:fs/promises";
import { environmentSecrets } from "@kenkaiiii/gg-ai";
import path from "node:path";
import type { AuthStorage } from "@kenkaiiii/gg-core";
import { getAllModels, getModel } from "../core/model-registry.js";
import { log } from "../core/logger.js";
import { getClaudeCliUserAgent } from "../core/claude-code-version.js";
import { isKimiCodingEndpoint, kimiCodingHeaders } from "../core/oauth/kimi.js";
import {
  DECISION_SERVICE_DEFAULTS,
  RouteCache,
  buildCapabilityRegistry,
  createDecisionsApiAdapter,
  createLlmDecisionAdapter,
  validateDecider,
  type AutoRouteConfig,
  type DecisionAdapter,
  type DecisionService,
  type ModelCapability,
  type RouteDiagnostic,
  type RouteFallbackReason,
} from "../core/routing/index.js";
import { ALL_PROVIDERS, loadAutoRouteConfig, saveAutoRouteConfig } from "./app-settings.js";

export interface CredentialStatus {
  set: boolean;
  masked: string | null;
}

export interface DeciderOption {
  id: string;
  label: string;
  kind: "model" | "decisions-api";
  provider?: string;
  model: string;
  service?: DecisionService;
  available: boolean;
  note?: string;
}

export interface BuiltAdapter {
  adapter: DecisionAdapter | null;
  reason?: RouteFallbackReason;
  /** HTTP status of the most recent decisions-api response (for plain-language test errors). */
  lastStatus: () => number | null;
}

/** `••••` plus the last four characters, and nothing else of the key. */
export function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

/** How long a built capability registry (one auth check per provider) is reused. */
export const REGISTRY_TTL_MS = 30_000;
export const DIAGNOSTICS_RING = 50;
export const DIAGNOSTICS_FILE_MAX_LINES = 500;

/** Content-free diagnostics: a small in-memory ring backed by a capped JSONL file. */
export class DiagnosticsLog {
  private ring: RouteDiagnostic[] = [];
  private seeded = false;
  private appended = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly trimEvery = 50,
  ) {}

  record(diagnostic: RouteDiagnostic): void {
    this.ring.push(diagnostic);
    if (this.ring.length > DIAGNOSTICS_RING) {
      this.ring.splice(0, this.ring.length - DIAGNOSTICS_RING);
    }
    const line = `${JSON.stringify(diagnostic)}\n`;
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, line, "utf-8");
        this.appended += 1;
        if (this.appended % this.trimEvery === 0) await this.trim();
      })
      .catch(() => {});
  }

  private async trim(): Promise<void> {
    const lines = (await fs.readFile(this.file, "utf-8")).split("\n").filter(Boolean);
    if (lines.length <= DIAGNOSTICS_FILE_MAX_LINES) return;
    await fs.writeFile(
      this.file,
      `${lines.slice(-DIAGNOSTICS_FILE_MAX_LINES).join("\n")}\n`,
      "utf-8",
    );
  }

  /** Newest last. Waits for pending writes so readers see them. */
  async recent(limit = DIAGNOSTICS_RING): Promise<RouteDiagnostic[]> {
    await this.chain;
    if (!this.seeded) {
      this.seeded = true;
      try {
        const lines = (await fs.readFile(this.file, "utf-8")).split("\n").filter(Boolean);
        const fromFile: RouteDiagnostic[] = [];
        for (const line of lines.slice(-DIAGNOSTICS_RING)) {
          try {
            fromFile.push(JSON.parse(line) as RouteDiagnostic);
          } catch {
            // skip a torn line
          }
        }
        // Every record of this process is also in the file, so the file is the superset.
        this.ring = fromFile;
      } catch {
        // no file yet
      }
    }
    return this.ring.slice(-limit);
  }
}

export interface RoutingRuntime {
  readonly cache: RouteCache;
  readonly diagnostics: DiagnosticsLog;
  config(): AutoRouteConfig;
  setConfig(config: AutoRouteConfig): Promise<void>;
  /** Called after the config is saved; returns an unsubscribe function. */
  onConfigChange(cb: (config: AutoRouteConfig) => void): () => void;
  /** Cached briefly (see REGISTRY_TTL_MS); dropped on config save and `invalidateRegistry`. */
  buildRegistry(config?: AutoRouteConfig): Promise<ModelCapability[]>;
  /** Drop the cached capability registry (after a login/logout or config change). */
  invalidateRegistry(): void;
  /** Stored keys/tokens and sensitive environment values, to redact from text sent to a decider. */
  secrets(): Promise<string[]>;
  buildAdapter(config?: AutoRouteConfig): Promise<BuiltAdapter>;
  credentialStatus(): Promise<{ openrouter: CredentialStatus; typesafe: CredentialStatus }>;
  deciderOptions(): Promise<DeciderOption[]>;
  validate(config: AutoRouteConfig): Promise<string[]>;
}

export interface RoutingRuntimeDeps {
  auth: AuthStorage;
  agentDir: string;
  fetchFn?: typeof fetch;
  /** Test seams. */
  initialConfig?: AutoRouteConfig;
  now?: () => number;
  persist?: (config: AutoRouteConfig) => Promise<void>;
}

export async function createRoutingRuntime(deps: RoutingRuntimeDeps): Promise<RoutingRuntime> {
  const { auth } = deps;
  let current = deps.initialConfig ?? (await loadAutoRouteConfig());
  const listeners = new Set<(config: AutoRouteConfig) => void>();
  const cache = new RouteCache();
  const diagnostics = new DiagnosticsLog(path.join(deps.agentDir, "routing-diagnostics.jsonl"));

  async function connectedProviders(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const p of ALL_PROVIDERS) {
      if (p !== "local" && (await auth.hasProviderAuth(p))) out.add(p);
    }
    return out;
  }

  async function credentialStatus() {
    const read = async (key: string): Promise<CredentialStatus> => {
      const creds = await auth.getCredentials(key);
      return creds?.accessToken
        ? { set: true, masked: maskKey(creds.accessToken) }
        : { set: false, masked: null };
    };
    return { openrouter: await read("openrouter"), typesafe: await read("typesafe") };
  }

  const now = deps.now ?? Date.now;
  let registryCache: { config: AutoRouteConfig; at: number; value: ModelCapability[] } | null =
    null;

  async function buildRegistry(config = current): Promise<ModelCapability[]> {
    if (
      registryCache &&
      registryCache.config === config &&
      now() - registryCache.at < REGISTRY_TTL_MS
    ) {
      return registryCache.value;
    }
    const connected = await connectedProviders();
    const value = buildCapabilityRegistry({
      models: getAllModels().filter((m) => m.provider !== "local"),
      isAvailable: (provider) => connected.has(provider),
      candidateAllowList: config.candidateModels,
    });
    registryCache = { config, at: now(), value };
    return value;
  }

  /** Stored API keys / tokens plus sensitive environment values, for redacting task text. */
  async function knownSecrets(): Promise<string[]> {
    const out = new Set<string>(environmentSecrets(process.env));
    for (const key of [...ALL_PROVIDERS, "openrouter", "typesafe"]) {
      try {
        const token = (await auth.getCredentials(key))?.accessToken;
        if (token && token.length >= 8) out.add(token);
      } catch {
        // an unreadable entry just isn't redacted by value
      }
    }
    return [...out].sort((a, b) => b.length - a.length);
  }

  return {
    cache,
    diagnostics,
    config: () => current,
    async setConfig(config) {
      await (deps.persist ?? saveAutoRouteConfig)(config);
      current = config;
      registryCache = null;
      cache.clear();
      for (const cb of listeners) {
        try {
          cb(config);
        } catch (err) {
          log("WARN", "routing", "config listener failed", { err: String(err) });
        }
      }
    },
    onConfigChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    buildRegistry,
    invalidateRegistry() {
      registryCache = null;
    },
    secrets: knownSecrets,
    async buildAdapter(config = current) {
      let status: number | null = null;
      const lastStatus = () => status;
      const d = config.decider;
      if (!d) return { adapter: null, reason: "no_decision_provider", lastStatus };
      if (d.kind === "decisions-api") {
        const svc = DECISION_SERVICE_DEFAULTS[d.service];
        const creds = await auth.getCredentials(svc.credentialKey);
        if (!creds?.accessToken) {
          return { adapter: null, reason: "missing_credentials", lastStatus };
        }
        const base = deps.fetchFn ?? globalThis.fetch;
        const tracked: typeof fetch = async (input, init) => {
          const res = await base(input, init);
          status = res.status;
          return res;
        };
        return {
          adapter: createDecisionsApiAdapter({
            service: d.service,
            apiKey: creds.accessToken,
            model: d.model,
            fetch: tracked,
          }),
          lastStatus,
        };
      }
      if (!(await auth.hasProviderAuth(d.provider))) {
        return { adapter: null, reason: "missing_credentials", lastStatus };
      }
      try {
        // The same resolver the agent loop uses: API key or a refreshed subscription (OAuth)
        // token, plus the account/project ids and endpoint that login needs.
        const creds = await auth.resolveCredentials(d.provider);
        return {
          adapter: createLlmDecisionAdapter({
            provider: d.provider,
            model: d.model,
            credentials: {
              apiKey: creds.accessToken,
              baseUrl: creds.baseUrl,
              accountId: creds.accountId,
              projectId: creds.projectId,
              ...(d.provider === "anthropic" ? { userAgent: await getClaudeCliUserAgent() } : {}),
              ...(d.provider === "moonshot" && isKimiCodingEndpoint(creds.baseUrl)
                ? { defaultHeaders: kimiCodingHeaders() }
                : {}),
            },
          }),
          lastStatus,
        };
      } catch {
        return { adapter: null, reason: "missing_credentials", lastStatus };
      }
    },
    credentialStatus,
    async deciderOptions() {
      const connected = await connectedProviders();
      const cred = await credentialStatus();
      const out: DeciderOption[] = [];
      for (const m of getAllModels()) {
        if (m.provider === "local" || !connected.has(m.provider)) continue;
        if (m.billing?.paid || (m.costTier !== "low" && m.costTier !== "medium")) continue;
        out.push({
          id: `model:${m.provider}:${m.id}`,
          label: m.name,
          kind: "model",
          provider: m.provider,
          model: m.id,
          available: true,
        });
      }
      const api = (service: DecisionService, model: string, label: string): DeciderOption => {
        const has = cred[service].set;
        return {
          id: `decisions-api:${service}:${model}`,
          label,
          kind: "decisions-api",
          model,
          service,
          available: has,
          ...(has
            ? {}
            : {
                note: `Add your ${DECISION_SERVICE_DEFAULTS[service].label} API key to use this.`,
              }),
        };
      };
      out.push(
        api("openrouter", "typesafe/jev-1.14", "Jev via OpenRouter"),
        api("typesafe", "jev-latest", "Jev via TypeSafe"),
        api("openrouter", "openai/gpt-6-luna-decisions", "GPT-6 Luna Decisions via OpenRouter"),
      );
      return out;
    },
    async validate(config) {
      const connected = await connectedProviders();
      const cred = await credentialStatus();
      const problems = validateDecider(config, {
        isAvailable: (provider, modelId) =>
          connected.has(provider) && getModel(modelId) !== undefined,
        hasCredential: (key) => (key === "typesafe" ? cred.typesafe.set : cred.openrouter.set),
      });
      if (config.enabled && (await buildRegistry(config)).length === 0) {
        problems.push(
          "No models are connected to route between. Sign in to a provider or loosen the allow-list.",
        );
      }
      return problems;
    },
  };
}
