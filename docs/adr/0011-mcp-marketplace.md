# ADR 0011: An MCP marketplace that scans before it adds

**Status:** Accepted, 2026-11-06.

## Context

An MCP server reached Israel Code only by pasting a `claude mcp add …` line
on the MCP servers page. The user had to find the server somewhere else, and
nothing looked at it before the agent started it with the user's environment.

Other tools have moved on. Cline ships an MCP marketplace inside the editor,
and the official MCP Registry (registry.modelcontextprotocol.io) now publishes
a public, keyless API of server listings: name, description, repository,
remote URLs and npm / PyPI / OCI packages with the env vars and headers they
need. Tools such as mcp-scan showed what to look for in a server before
trusting it, and 2025–26 brought real incidents: npm MCP packages that quietly
copied mail or keys out, tool descriptions carrying prompt injection ("tool
poisoning"), and look-alike names squatting on popular servers. As with skills
(ADR 0005), the damage happens at install or first start.

## Decision

- **"Browse marketplace"** on the MCP servers page
  (`gg-app/src/McpModal.tsx`) opens the marketplace panel
  (`gg-app/src/McpMarketModal.tsx`) above the server list: search, results,
  detail with run options, needed values, scan, scope and Add.
- **Registry API only, no key.** `core/mcp-registry.ts` talks to the official
  MCP Registry (`searchMcpRegistry`, `getMcpListing`, `listingToConfig`). No
  other index is queried and there is no setting for a token.
- **Static scan, nothing runs.** `core/mcp-scan.ts` applies rules MCP-01 to
  MCP-10, reusing the skill scanner, to the listing, the npm or PyPI metadata
  and the README. The server is never started, installed or `npx`-ed before
  the user adds it. The verdict is `pass`, `warn` (medium/low only) or
  `block` (any critical or high).
- **Block means block.** Add is disabled; "Add anyway" opens a confirm step
  ("Israel Code will not vouch for it") whose default is Cancel. Confirming
  sends `override: true`; `POST /mcp/market/add` answers 409 to a block
  without it, and every override is logged.
- **Same add path.** The chosen option (remote URL or package) becomes a
  server config, filled with the env vars and headers the user typed (secret
  ones in password fields), and goes through the existing `addServer` path,
  so Global and Project scope, the project-scope trust behaviour and the
  "loads after a restart" rule are the same as for a pasted line.
- Three layers as usual: sidecar routes (`app-sidecar/mcp-market-routes.ts`),
  Rust proxies (`src-tauri/src/commands/mcp_market.rs`), typed wrappers in
  `agent.ts` (`searchMcpMarket`, `inspectMcpMarket`, `addMcpFromMarket`).

## Consequences

- Finding and adding a server takes a search and two clicks, and the user
  sees the scan before the server ever runs.
- Static rules miss payloads fetched at runtime, a remote server that changes
  behaviour after it is added, and anything not in the published metadata;
  they also flag legitimate install scripts. The evidence is shown so the
  user can judge; the verdict is a floor, not a promise.
- A remote server is only as safe as its host: the scan reads its listing,
  not its code.
- Registry listings are self-published; pasting a line still works for
  servers that are missing or listed wrongly.

## Out of scope

- No LLM judge of a server's intent: the verdict comes from rules alone.
- No runtime sandboxing or tool-call monitoring of added servers (the
  existing tool safety guard still applies).
- No Smithery, Glama, mcp.so or other registries.
- No automatic re-scans or updates of servers already added.
