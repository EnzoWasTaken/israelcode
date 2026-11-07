import { describe, expect, it, vi } from "vitest";
import {
  getMcpListing,
  listingToConfig,
  searchMcpRegistry,
  serverNameFor,
  type McpListing,
} from "./mcp-registry.js";

function entry(server: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return {
    server,
    _meta: {
      "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, ...meta },
    },
  };
}

function fakeFetch(handler: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const LISTING: McpListing = {
  name: "io.github.acme/weather",
  description: "Weather tools",
  version: "1.2.0",
  repository: { url: "https://github.com/acme/weather", source: "github" },
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
      version: "1.2.0",
      environmentVariables: [
        { name: "WEATHER_API_KEY", isRequired: true, isSecret: true },
        { name: "WEATHER_UNITS", isRequired: false, value: "metric" },
      ],
      packageArguments: [{ type: "positional", value: "--stdio" }],
    },
    { registryType: "pypi", identifier: "weather-mcp" },
    { registryType: "oci", identifier: "ghcr.io/acme/weather:1" },
  ],
};

describe("searchMcpRegistry", () => {
  it("sends search, limit and cursor and maps the official meta", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toContain("/v0/servers?search=weather&limit=5&cursor=abc");
      return {
        servers: [entry({ name: "io.github.acme/weather", description: "d", version: "1.0.0" })],
        metadata: { nextCursor: "next", count: 1 },
      };
    });
    const res = await searchMcpRegistry("weather", { limit: 5, cursor: "abc", fetch: fetchFn });
    expect(res.nextCursor).toBe("next");
    expect(res.servers[0]).toMatchObject({
      name: "io.github.acme/weather",
      status: "active",
      isLatest: true,
    });
    const call = vi.mocked(fetchFn).mock.calls[0]?.[1] as RequestInit;
    expect((call.headers as Record<string, string>)["user-agent"]).toBe("IsraelCode");
  });

  it("drops deprecated, deleted and non-latest entries by default", async () => {
    const fetchFn = fakeFetch(() => ({
      servers: [
        entry({ name: "a/active", description: "", version: "1" }),
        entry({ name: "a/old", description: "", version: "0" }, { isLatest: false }),
        entry({ name: "a/dep", description: "", version: "1" }, { status: "deprecated" }),
        entry({ name: "a/del", description: "", version: "1" }, { status: "deleted" }),
      ],
      metadata: {},
    }));
    const res = await searchMcpRegistry("", { fetch: fetchFn });
    expect(res.servers.map((s) => s.name)).toEqual(["a/active"]);
    expect(res.nextCursor).toBeUndefined();
  });

  it("explains a timeout or a bad answer in plain words", async () => {
    const timeout = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(searchMcpRegistry("x", { fetch: timeout })).rejects.toThrow(
      "did not answer in 10 s",
    );
    const broken = vi.fn(
      async () => new Response("<html>", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(searchMcpRegistry("x", { fetch: broken })).rejects.toThrow("answered 500");
  });
});

describe("getMcpListing", () => {
  it("reads a specific version and 404s in plain words", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url.endsWith("/servers/io.github.acme%2Fweather/versions/1.2.0")) {
        return entry({ name: "io.github.acme/weather", description: "d", version: "1.2.0" });
      }
      return undefined;
    });
    const l = await getMcpListing("io.github.acme/weather", "1.2.0", { fetch: fetchFn });
    expect(l.version).toBe("1.2.0");
    await expect(getMcpListing("nope/none", undefined, { fetch: fetchFn })).rejects.toThrow(
      "Not found in the MCP registry.",
    );
  });
});

describe("listingToConfig", () => {
  it("maps a remote to a url config with required headers as placeholders", () => {
    const { config, needs } = listingToConfig(LISTING, { kind: "remote", index: 0 });
    expect(config).toEqual({
      name: "weather",
      url: "https://mcp.acme.test/mcp",
      transport: "http",
      enabled: true,
      headers: { Authorization: "" },
    });
    expect(needs).toEqual({
      envNames: [],
      headerNames: ["Authorization"],
      secrets: ["Authorization"],
    });
  });

  it("maps npm, pypi and oci packages to npx, uvx and docker commands", () => {
    const npm = listingToConfig(LISTING, { kind: "package", index: 0 });
    expect(npm.config).toMatchObject({
      name: "weather",
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.2.0", "--stdio"],
      env: { WEATHER_API_KEY: "", WEATHER_UNITS: "metric" },
      enabled: true,
    });
    expect(npm.needs).toEqual({
      envNames: ["WEATHER_API_KEY"],
      headerNames: [],
      secrets: ["WEATHER_API_KEY"],
    });
    expect(listingToConfig(LISTING, { kind: "package", index: 1 }).config).toMatchObject({
      command: "uvx",
      args: ["weather-mcp"],
    });
    expect(listingToConfig(LISTING, { kind: "package", index: 2 }).config).toMatchObject({
      command: "docker",
      args: ["run", "-i", "--rm", "ghcr.io/acme/weather:1"],
    });
    expect(serverNameFor({ name: "ai.smithery/Some Thing!" })).toBe("Some-Thing");
    expect(() => listingToConfig(LISTING, { kind: "package", index: 9 })).toThrow(
      "no such package",
    );
  });
});
