import { Readable } from "node:stream";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Registry from "../core/mcp-registry.js";

vi.mock("../core/mcp-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>();
  return { ...actual, searchMcpRegistry: vi.fn(), getMcpListing: vi.fn() };
});
vi.mock("../core/mcp-scan.js", () => ({
  collectMcpScanExtras: vi.fn(async () => ({})),
  scanMcpListing: vi.fn(),
}));
vi.mock("../core/mcp/index.js", () => ({ addServer: vi.fn() }));
vi.mock("./mcp-rows.js", () => ({
  probeMcp: vi.fn(async () => ({ ok: true, toolCount: 3 })),
}));
vi.mock("../core/logger.js", () => ({ log: vi.fn() }));

import { log } from "../core/logger.js";
import { addServer } from "../core/mcp/index.js";
import { getMcpListing, searchMcpRegistry, type McpListing } from "../core/mcp-registry.js";
import { scanMcpListing } from "../core/mcp-scan.js";
import { handleMcpMarketRoutes } from "./mcp-market-routes.js";
import type { SessionRouteContext } from "./route-context.js";

interface Reply {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: http.ServerResponse; reply: Promise<Reply> } {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  return { res: res as unknown as http.ServerResponse, reply };
}

const trustProject = vi.fn(async () => {});
const count = vi.fn();
const ctx = {
  host: "127.0.0.1:1",
  cwd: "C:\\proj",
  sessionId: "s1",
  session: { trustProject },
  trophies: { count },
} as unknown as SessionRouteContext;

function call(method: string, url: string, body?: unknown): Promise<Reply> {
  const { res, reply } = fakeResponse();
  const req =
    body === undefined
      ? ({} as http.IncomingMessage)
      : (Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage);
  expect(handleMcpMarketRoutes(ctx, req, res, url, method)).toBe(true);
  return reply;
}

const LISTING: McpListing = {
  name: "io.github.acme/weather",
  description: "Weather",
  version: "1.0.0",
  remotes: [
    {
      type: "streamable-http",
      url: "https://mcp.acme.test/mcp",
      headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
    },
  ],
  packages: [
    {
      registryType: "npm",
      identifier: "@acme/weather-mcp",
      version: "1.0.0",
      environmentVariables: [{ name: "WEATHER_API_KEY", isRequired: true, isSecret: true }],
    },
  ],
};
const PASS = { verdict: "pass" as const, findings: [], summary: "No findings", rulesRun: 10 };
const BLOCK = {
  verdict: "block" as const,
  findings: [
    {
      rule: "MCP-04",
      title: "scripts",
      severity: "high" as const,
      file: "package:@acme/weather-mcp",
      line: 0,
      reason: "r",
    },
  ],
  summary: "1 blocking finding",
  rulesRun: 10,
};

describe("mcp market routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMcpListing).mockResolvedValue(LISTING);
    vi.mocked(scanMcpListing).mockReturnValue(PASS);
    vi.mocked(addServer).mockResolvedValue({ ok: true });
  });

  it("ignores unrelated urls", () => {
    const { res } = fakeResponse();
    expect(handleMcpMarketRoutes(ctx, {} as http.IncomingMessage, res, "/mcp", "GET")).toBe(false);
    expect(handleMcpMarketRoutes(ctx, {} as http.IncomingMessage, res, "/mcp/add", "POST")).toBe(
      false,
    );
  });

  it("GET /mcp/market/search passes q and cursor and maps registry errors", async () => {
    vi.mocked(searchMcpRegistry).mockResolvedValueOnce({ servers: [LISTING], nextCursor: "n" });
    expect(await call("GET", "/mcp/market/search?q=weather&cursor=c1")).toEqual({
      status: 200,
      body: { servers: [LISTING], nextCursor: "n" },
    });
    expect(searchMcpRegistry).toHaveBeenCalledWith("weather", { cursor: "c1" });

    vi.mocked(searchMcpRegistry).mockRejectedValueOnce(new Error("offline"));
    const bad = await call("GET", "/mcp/market/search?q=x");
    expect(bad.status).toBe(500);
    expect(bad.body).toEqual({ servers: [], error: "offline" });
  });

  it("POST /mcp/market/inspect returns listing, run options and the scan without adding", async () => {
    const reply = await call("POST", "/mcp/market/inspect", { name: LISTING.name });
    expect(reply.status).toBe(200);
    const body = reply.body as { listing: McpListing; options: unknown[]; scan: unknown };
    expect(body.listing.name).toBe(LISTING.name);
    expect(body.scan).toEqual(PASS);
    expect(body.options).toEqual([
      expect.objectContaining({
        kind: "remote",
        index: 0,
        config: expect.objectContaining({ url: "https://mcp.acme.test/mcp" }),
        needs: { envNames: [], headerNames: ["Authorization"], secrets: ["Authorization"] },
      }),
      expect.objectContaining({
        kind: "package",
        index: 0,
        config: expect.objectContaining({ command: "npx" }),
        needs: { envNames: ["WEATHER_API_KEY"], headerNames: [], secrets: ["WEATHER_API_KEY"] },
      }),
    ]);
    expect(addServer).not.toHaveBeenCalled();
    expect((await call("POST", "/mcp/market/inspect", {})).status).toBe(400);
  });

  it("POST /mcp/market/add refuses a block with 409 unless override, which is logged", async () => {
    vi.mocked(scanMcpListing).mockReturnValue(BLOCK);
    const refused = await call("POST", "/mcp/market/add", {
      name: LISTING.name,
      choice: { kind: "package", index: 0 },
      scope: "global",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      added: false,
      scan: BLOCK,
      error: "Blocked by the security scan",
    });
    expect(addServer).not.toHaveBeenCalled();

    const forced = await call("POST", "/mcp/market/add", {
      name: LISTING.name,
      choice: { kind: "package", index: 0 },
      scope: "global",
      override: true,
    });
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ added: true, name: "weather", scan: BLOCK });
    expect(log).toHaveBeenCalledWith(
      "WARN",
      "app-sidecar",
      "MCP server added despite blocking findings",
      expect.objectContaining({ name: LISTING.name }),
    );
  });

  it("POST /mcp/market/add merges values, saves with enabled:true and trusts a project", async () => {
    const reply = await call("POST", "/mcp/market/add", {
      name: LISTING.name,
      choice: { kind: "package", index: 0 },
      scope: "project",
      cwd: "D:\\other",
      values: { env: { WEATHER_API_KEY: "k-123" } },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      added: true,
      name: "weather",
      connected: true,
      toolCount: 3,
    });
    expect(addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "weather",
        command: "npx",
        env: { WEATHER_API_KEY: "k-123" },
        enabled: true,
      }),
      "project",
      "D:\\other",
      true,
    );
    expect(trustProject).toHaveBeenCalledWith("D:\\other");
    expect(count).toHaveBeenCalledWith("mcpServersAdded", "s1");

    const noCwd = await call("POST", "/mcp/market/add", {
      name: LISTING.name,
      choice: { kind: "remote", index: 0 },
      scope: "project",
    });
    expect(noCwd.status).toBe(400);
  });
});
