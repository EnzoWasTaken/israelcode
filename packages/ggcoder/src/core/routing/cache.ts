import type { ModelCapability } from "./capabilities.js";
import type { AutoRouteConfig } from "./config.js";
import { shortHash } from "./hash.js";
import type { RouteSignals } from "./signals.js";
import type { RouteDecision, RouteRequest } from "./types.js";

interface Entry {
  decision: RouteDecision;
  expiresAt: number;
}

/**
 * Bounded in-memory LRU of routing decisions. Keys are hashes; raw task text is
 * never stored.
 */
export class RouteCache {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { max?: number; now?: () => number } = {}) {
    this.max = Math.max(1, opts.max ?? 100);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  private read(key: string): RouteDecision | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.decision;
  }

  private write(key: string, decision: RouteDecision, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { decision, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string): RouteDecision | undefined {
    return this.read(key);
  }

  set(key: string, decision: RouteDecision, ttlMs: number): void {
    this.write(key, decision, ttlMs);
  }

  /** The most recent stored decision for a session (used to reuse across follow-ups). */
  getLast(sessionKey: string): RouteDecision | undefined {
    return this.read(`last:${shortHash(sessionKey)}`);
  }

  setLast(sessionKey: string, decision: RouteDecision, ttlMs: number): void {
    this.write(`last:${shortHash(sessionKey)}`, decision, ttlMs);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function registryFingerprint(registry: readonly ModelCapability[]): string {
  return shortHash(
    registry
      .map(
        (c) => `${c.provider}:${c.model}:${c.vision ? 1 : 0}${c.video ? 1 : 0}:${c.contextWindow}`,
      )
      .sort()
      .join("|"),
  );
}

export function configFingerprint(config: AutoRouteConfig): string {
  return shortHash(JSON.stringify(config));
}

export function routeCacheKey(
  req: RouteRequest,
  signals: RouteSignals,
  config: AutoRouteConfig,
  registry: readonly ModelCapability[],
): string {
  const normalized = req.text.toLowerCase().replace(/\s+/g, " ").trim();
  const modalities = [...new Set(req.attachments.map((a) => a.kind))].sort().join(",");
  return shortHash(
    JSON.stringify([
      req.conversation.sessionKey,
      shortHash(normalized, 32),
      modalities,
      signals.needsImage,
      signals.needsVideo,
      req.pins,
      configFingerprint(config),
      registryFingerprint(registry),
      req.workspace,
      req.isGoal,
      req.hasSpawnAgent,
      req.current.provider,
      req.current.model,
    ]),
    32,
  );
}
