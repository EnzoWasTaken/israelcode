import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircleIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Badge } from "./Badge";
import { ListSkeleton } from "./Skeleton";
import {
  searchMcpMarket,
  inspectMcpMarket,
  addMcpFromMarket,
  listProjects,
  type DiscoveredProject,
  type McpListing,
  type McpMarketInspection,
  type McpMarketOption,
  type SkillScanReport,
  type SkillScanSeverity,
} from "./agent";
import { toast } from "./toast";

interface Props {
  /** Called after a server was added, so the caller can re-list its servers. */
  onAdded?: () => void;
}

/**
 * MCP marketplace — shown inside the MCP servers page. Searches the official
 * MCP Registry, reads one listing with its run options and a static scan, then
 * adds it through the same path as a pasted `claude mcp add`. Nothing from the
 * server runs before it is added; a "block" verdict needs an explicit override.
 */
const SEARCH_DEBOUNCE_MS = 350;
const SEVERITIES: SkillScanSeverity[] = ["critical", "high", "medium", "low"];
const mono = { fontFamily: "var(--mono)", fontSize: "var(--fs-xs)" } as const;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function repoHost(listing: McpListing): string | undefined {
  const url = listing.repository?.url;
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return listing.repository?.source;
  }
}

function listingBadges(listing: McpListing): string[] {
  const out = new Set<string>();
  if (listing.remotes?.length) out.add("remote");
  for (const p of listing.packages ?? []) {
    const t = p.registryType.toLowerCase();
    if (t === "npm" || t === "pypi") out.add(t);
    else if (t === "oci" || t === "docker") out.add("docker");
  }
  return [...out];
}

function ScanReport({ scan }: { scan: SkillScanReport }): React.ReactElement {
  const color =
    scan.verdict === "pass" ? theme.success : scan.verdict === "warn" ? theme.warning : theme.error;
  const Icon =
    scan.verdict === "pass"
      ? CheckCircleIcon
      : scan.verdict === "warn"
        ? WarningCircleIcon
        : XCircleIcon;
  const headline =
    scan.verdict === "pass"
      ? `No findings, ${scan.rulesRun} rule${scan.rulesRun === 1 ? "" : "s"}`
      : scan.verdict === "warn"
        ? `Findings to read before you add it: ${scan.summary}`
        : `Blocked: ${scan.summary}`;
  return (
    <div className="mcp-market-scan">
      <div
        className="mcp-market-banner"
        role={scan.verdict === "block" ? "alert" : "status"}
        style={{ border: `1px solid ${color}`, color }}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{headline}</span>
      </div>
      {SEVERITIES.map((severity) => {
        const group = scan.findings.filter((f) => f.severity === severity);
        if (group.length === 0) return null;
        return (
          <div key={severity} style={{ marginTop: "var(--space-4)" }}>
            <h4
              className="mcp-market-severity"
              style={{
                color: severity === "critical" || severity === "high" ? theme.error : theme.warning,
              }}
            >
              {severity} ({group.length})
            </h4>
            <ul className="mcp-market-findings">
              {group.map((f, i) => (
                <li
                  key={`${f.rule}:${f.file}:${f.line}:${i}`}
                  style={{ borderColor: theme.border }}
                >
                  <div style={{ color: theme.text }}>
                    <span style={{ ...mono, color: theme.textMuted }}>{f.rule}</span> {f.title}
                  </div>
                  <div style={{ color: theme.textSecondary }}>{f.reason}</div>
                  {f.evidence && (
                    <pre style={{ ...mono, background: theme.surface1, color: theme.text }}>
                      {f.evidence}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function McpMarketModal({ onAdded }: Props): React.ReactElement {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [servers, setServers] = useState<McpListing[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const [selected, setSelected] = useState<McpListing | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<McpMarketInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [optionIdx, setOptionIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});

  const [scope, setScope] = useState<"global" | "project">("global");
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const runSearch = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    const seq = ++searchSeq.current;
    if (!trimmed) {
      setServers(null);
      setNextCursor(undefined);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const res = await searchMcpMarket(trimmed);
      if (seq !== searchSeq.current) return;
      setServers(res.servers);
      setNextCursor(res.nextCursor);
      setSearchError(null);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setSearchError(`Search failed: ${errorText(e)}`);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await searchMcpMarket(query.trim(), nextCursor);
      setServers((prev) => [...(prev ?? []), ...res.servers]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setSearchError(`Couldn't load more: ${errorText(e)}`);
    } finally {
      setLoadingMore(false);
    }
  }

  async function inspect(listing: McpListing): Promise<void> {
    setSelected(listing);
    setInspecting(true);
    setInspection(null);
    setInspectError(null);
    setConfirmOverride(false);
    setAddError(null);
    setOptionIdx(0);
    setValues({});
    try {
      setInspection(await inspectMcpMarket(listing.name, listing.version));
    } catch (e) {
      setInspectError(`Couldn't read this listing: ${errorText(e)}`);
    } finally {
      setInspecting(false);
    }
  }

  const option: McpMarketOption | undefined = inspection?.options[optionIdx];
  const blocked = inspection?.scan.verdict === "block";
  const blockingCount =
    inspection?.scan.findings.filter((f) => f.severity === "critical" || f.severity === "high")
      .length ?? 0;

  /** Is this env var / header marked required in the listing? */
  function isRequired(kind: "env" | "header", name: string): boolean {
    if (!inspection || !option) return false;
    if (kind === "header") {
      const remote = inspection.listing.remotes?.[option.index];
      return !!remote?.headers?.find((h) => h.name === name)?.isRequired;
    }
    const pkg = inspection.listing.packages?.[option.index];
    return !!pkg?.environmentVariables?.find((v) => v.name === name)?.isRequired;
  }

  async function add(override: boolean): Promise<void> {
    if (!inspection || !option || adding) return;
    if (scope === "project" && !projectPath) {
      toast("Enter or pick a project path first.", "warning");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      for (const n of option.needs.envNames) if (values[`env:${n}`]) env[n] = values[`env:${n}`]!;
      for (const n of option.needs.headerNames)
        if (values[`header:${n}`]) headers[n] = values[`header:${n}`]!;
      const result = await addMcpFromMarket({
        name: inspection.listing.name,
        version: inspection.listing.version,
        choice: { kind: option.kind, index: option.index },
        scope,
        cwd: scope === "project" ? projectPath : undefined,
        values: { env, headers },
        ...(override ? { override: true } : {}),
      });
      if (result.added) {
        setConfirmOverride(false);
        const name = result.name ?? option.config.name;
        if (result.connected) toast(`Added "${name}" (${result.toolCount ?? 0} tools).`, "success");
        else if (result.requiresAuth) toast(`Added "${name}". Click "Sign in" to connect.`, "info");
        else toast(`Saved "${name}". It loads after a restart.`, "success");
        onAdded?.();
      } else {
        setAddError(result.error ?? "Israel Code refused to add this server.");
      }
    } catch (e) {
      setAddError(errorText(e));
    } finally {
      setAdding(false);
    }
  }

  const needs = option
    ? [
        ...option.needs.envNames.map((n) => ({ kind: "env" as const, name: n })),
        ...option.needs.headerNames.map((n) => ({ kind: "header" as const, name: n })),
      ]
    : [];

  return (
    <div className="mcp-market" aria-label="MCP marketplace">
      <input
        className="modal-input"
        type="search"
        aria-label="Search the MCP marketplace"
        style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
        value={query}
        placeholder="Search the MCP Registry, e.g. github, postgres, notion"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void runSearch(query);
        }}
      />
      {searchError && (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {searchError}
        </div>
      )}
      {searching ? (
        <ListSkeleton rows={3} />
      ) : servers && servers.length === 0 ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          Nothing found for "{query.trim()}".
        </div>
      ) : servers ? (
        <>
          <ul className="mcp-list mcp-market-results" aria-label="Marketplace results">
            {servers.map((s) => {
              const isSelected = selected?.name === s.name && selected.version === s.version;
              const host = repoHost(s);
              return (
                <li key={`${s.name}@${s.version}`}>
                  <button
                    type="button"
                    className="mcp-item mcp-market-row"
                    aria-pressed={isSelected}
                    style={{ background: isSelected ? theme.surface2 : undefined }}
                    onClick={() => void inspect(s)}
                  >
                    <span className="mcp-name" style={{ color: theme.text }}>
                      {s.title || s.name}
                    </span>
                    <span className="mcp-meta" style={{ ...mono, color: theme.textDim }}>
                      v{s.version}
                    </span>
                    {host && (
                      <span className="mcp-meta" style={{ ...mono, color: theme.textDim }}>
                        {host}
                      </span>
                    )}
                    {listingBadges(s).map((b) => (
                      <Badge key={b}>{b}</Badge>
                    ))}
                    {s.status === "deprecated" && <Badge color={theme.warning}>Deprecated</Badge>}
                    {s.description && (
                      <span className="mcp-market-desc" style={{ color: theme.textSecondary }}>
                        {s.description}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {nextCursor && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading\u2026" : "Load more"}
            </button>
          )}
        </>
      ) : null}

      {inspecting ? (
        <ListSkeleton rows={4} />
      ) : inspectError ? (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {inspectError}
        </div>
      ) : inspection ? (
        <div className="mcp-market-detail">
          <h4 style={{ margin: 0, color: theme.text }}>
            {inspection.listing.title || inspection.listing.name}
          </h4>
          <div style={{ ...mono, color: theme.textDim }}>
            {inspection.listing.name} v{inspection.listing.version}
          </div>
          {inspection.listing.description && (
            <p style={{ color: theme.textSecondary }}>{inspection.listing.description}</p>
          )}
          {inspection.listing.repository?.url && (
            <div style={{ ...mono, color: theme.textMuted }}>
              Source: {inspection.listing.repository.url}
            </div>
          )}

          {inspection.options.length === 0 ? (
            <div className="modal-hint" style={{ color: theme.warning }}>
              This listing has no remote URL or package Israel Code can run.
            </div>
          ) : inspection.options.length > 1 ? (
            <fieldset className="mcp-market-options">
              <legend style={{ color: theme.textMuted }}>How to run it</legend>
              {inspection.options.map((o, i) => (
                <label key={`${o.kind}:${o.index}`} style={{ color: theme.text }}>
                  <input
                    type="radio"
                    name="mcp-market-option"
                    checked={optionIdx === i}
                    onChange={() => {
                      setOptionIdx(i);
                      setValues({});
                    }}
                  />{" "}
                  {o.label}
                </label>
              ))}
            </fieldset>
          ) : (
            <div style={{ ...mono, color: theme.textDim }}>{option?.label}</div>
          )}

          {needs.length > 0 && (
            <div className="mcp-market-needs">
              <div className="modal-label" style={{ color: theme.textMuted }}>
                It needs
              </div>
              {needs.map(({ kind, name }) => {
                const id = `mcp-market-${kind}-${name}`;
                const required = isRequired(kind, name);
                const secret = option?.needs.secrets.includes(name) ?? false;
                return (
                  <div key={id} className="mcp-market-need">
                    <label htmlFor={id} style={{ ...mono, color: theme.text }}>
                      {name}
                      {kind === "header" ? " (header)" : ""}
                      {required ? " (required)" : ""}
                    </label>
                    <input
                      id={id}
                      className="modal-input"
                      type={secret ? "password" : "text"}
                      autoComplete="off"
                      required={required}
                      style={{ color: theme.text, background: theme.inputBackground }}
                      value={values[`${kind}:${name}`] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [`${kind}:${name}`]: e.target.value }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: "var(--space-5)" }}>
            <ScanReport scan={inspection.scan} />
          </div>

          <div className="mcp-scope-toggle" role="group" aria-label="Add to">
            <button
              type="button"
              className={`modal-btn${scope === "global" ? " primary" : ""}`}
              aria-pressed={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global
            </button>
            <button
              type="button"
              className={`modal-btn${scope === "project" ? " primary" : ""}`}
              aria-pressed={scope === "project"}
              onClick={() => setScope("project")}
            >
              Project
            </button>
          </div>
          {scope === "project" && (
            <>
              <input
                className="modal-input"
                aria-label="Project path"
                style={{
                  color: projectPath ? theme.text : theme.textMuted,
                  background: theme.inputBackground,
                  width: "100%",
                  marginTop: "var(--space-5)",
                }}
                value={projectPath}
                placeholder="Type a project path or pick below…"
                list="mcp-market-project-paths"
                onChange={(e) => setProjectPath(e.target.value)}
              />
              <datalist id="mcp-market-project-paths">
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </datalist>
            </>
          )}

          {addError && (
            <div className="modal-error" role="alert" style={{ color: theme.error }}>
              {addError}
            </div>
          )}

          <div className="modal-actions">
            {blocked && !confirmOverride && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ color: theme.textMuted, textDecoration: "underline" }}
                disabled={!option}
                onClick={() => setConfirmOverride(true)}
              >
                Add anyway
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!option || blocked || adding}
              title={blocked ? "The scan blocked this server" : undefined}
              onClick={() => void add(false)}
            >
              {adding ? "Adding\u2026" : "Add"}
            </button>
          </div>

          {confirmOverride && (
            <div
              role="alertdialog"
              aria-labelledby="mcp-market-override-title"
              className="mcp-market-confirm"
              style={{ border: `1px solid ${theme.error}` }}
            >
              <p id="mcp-market-override-title" style={{ margin: 0, color: theme.text }}>
                You are about to add this server despite {blockingCount} blocking finding
                {blockingCount === 1 ? "" : "s"}. Israel Code will not vouch for it.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  autoFocus
                  onClick={() => setConfirmOverride(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ color: theme.error }}
                  disabled={adding}
                  onClick={() => void add(true)}
                >
                  {adding ? "Adding\u2026" : "Add despite findings"}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : servers ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          Pick a server to see how it runs and what the scan found.
        </div>
      ) : null}
    </div>
  );
}
