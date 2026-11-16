import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLocalModelId } from "@kenkaiiii/gg-core";
import type { SessionRouteContext } from "./route-context.js";

// os.homedir() reads USERPROFILE on Windows; keep gg-app.json off the real profile.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const logged = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("../core/logger.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../core/logger.js")>();
  return { ...actual, log: logged.log };
});

const derived = vi.hoisted(() => ({
  ensure: vi.fn(async (_endpoint: unknown, rawId: string) => `${rawId}-israelcode`),
  remove: vi.fn(async () => {}),
}));
vi.mock("@kenkaiiii/gg-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@kenkaiiii/gg-core")>();
  return {
    ...actual,
    ensureOllamaDerivedModel: derived.ensure,
    deleteOllamaDerivedModel: derived.remove,
  };
});

const { handleIntegrationRoutes } = await import("./integration-routes.js");
const { loadLocalSettings } = await import("../core/local-settings-store.js");

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function call(ctx: SessionRouteContext, url: string, body: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    let status = 0;
    const res: { headersSent: boolean; writeHead(code: number): unknown; end(p: string): void } = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
      },
    };
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as http.IncomingMessage;
    handleIntegrationRoutes(ctx, req, res as unknown as http.ServerResponse, url, "PUT");
  });
}

const modelId = formatLocalModelId("ollama", "qwen3:8b");
let ctx: SessionRouteContext;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-local-routes-"));
  ctx = {
    scanLocalModels: vi.fn(async () => []),
    clampLocalThinking: vi.fn(),
    localStatePayload: () => ({ endpoints: [] }),
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
  } as unknown as SessionRouteContext;
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("PUT /local/settings/* on Ollama", () => {
  beforeEach(() => {
    derived.ensure.mockClear();
    derived.remove.mockClear();
  });

  it("creates the derived model before saving runtime settings", async () => {
    const reply = await call(ctx, "/local/settings/model", {
      id: modelId,
      settings: { gpuLayers: 20, contextWindow: 16384 },
    });
    expect(reply.status).toBe(200);
    expect(derived.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ollama" }),
      "qwen3:8b",
      { num_ctx: 16384, num_gpu: 20 },
    );
    expect((await loadLocalSettings()).models[modelId]).toMatchObject({ gpuLayers: 20 });
  });

  it("rejects and saves nothing when Ollama refuses", async () => {
    derived.ensure.mockRejectedValueOnce(new Error("no memory"));
    const reply = await call(ctx, "/local/settings/model", {
      id: modelId,
      settings: { gpuLayers: 20 },
    });
    expect(reply).toEqual({ status: 400, body: { error: "Could not apply to Ollama: no memory" } });
    expect((await loadLocalSettings()).models).toEqual({});
  });

  it("deletes the derived model when runtime settings go away", async () => {
    await call(ctx, "/local/settings/model", { id: modelId, settings: { temperature: 0.3 } });
    expect(derived.ensure).not.toHaveBeenCalled();
    expect(derived.remove).toHaveBeenCalled();
  });
});

describe("PUT /local/settings/*", () => {
  it("saves model settings, rescans without forcing, and broadcasts", async () => {
    const reply = await call(ctx, "/local/settings/model", {
      id: modelId,
      settings: { contextWindow: 32768, maxOutputTokens: 8192, temperature: 0.2 },
    });
    expect(reply.status).toBe(200);
    expect(ctx.scanLocalModels).toHaveBeenCalledWith(false);
    expect(ctx.clampLocalThinking).toHaveBeenCalled();
    expect(ctx.broadcast).toHaveBeenCalledWith("models_change", expect.anything());
    expect((await loadLocalSettings()).models[modelId]).toEqual({
      contextWindow: 32768,
      maxOutputTokens: 8192,
      temperature: 0.2,
    });
  });

  it("clears settings with null", async () => {
    await call(ctx, "/local/settings/model", { id: modelId, settings: { topK: 40 } });
    const reply = await call(ctx, "/local/settings/model", { id: modelId, settings: null });
    expect(reply.status).toBe(200);
    expect((await loadLocalSettings()).models).toEqual({});
  });

  it("saves endpoint headers", async () => {
    const reply = await call(ctx, "/local/settings/endpoint", {
      id: "ollama",
      settings: { headers: { "X-Org": "abc" } },
    });
    expect(reply.status).toBe(200);
    expect((await loadLocalSettings()).endpoints["ollama"]).toEqual({
      headers: { "X-Org": "abc" },
    });
  });

  it("never logs header values or the extra body", async () => {
    logged.log.mockClear();
    await call(ctx, "/local/settings/endpoint", {
      id: "ollama",
      settings: { headers: { "X-Org": "hdr-secret-value" } },
    });
    await call(ctx, "/local/settings/model", {
      id: modelId,
      settings: { extraBody: { note: "body-secret-value" } },
    });
    const text = JSON.stringify(logged.log.mock.calls);
    expect(text).not.toContain("hdr-secret-value");
    expect(text).not.toContain("body-secret-value");
  });

  it("rejects invalid input with the first message and saves nothing", async () => {
    const reply = await call(ctx, "/local/settings/model", {
      id: modelId,
      settings: { temperature: 9 },
    });
    expect(reply.status).toBe(400);
    expect(reply.body["error"]).toBe("Temperature must be between 0 and 2.");
    expect(await loadLocalSettings()).toEqual({ models: {}, endpoints: {} });
  });

  it("rejects unknown ids", async () => {
    expect((await call(ctx, "/local/settings/model", { id: "gpt-5", settings: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call(ctx, "/local/settings/model", {
          id: formatLocalModelId("nope", "x"),
          settings: {},
        })
      ).status,
    ).toBe(400);
    expect((await call(ctx, "/local/settings/endpoint", { id: "nope", settings: {} })).status).toBe(
      400,
    );
  });
});
