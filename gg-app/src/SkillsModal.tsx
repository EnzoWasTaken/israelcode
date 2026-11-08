import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircleIcon, WarningCircleIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { Badge } from "./Badge";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { ListSkeleton } from "./Skeleton";
import { SettingsCard, SettingsSection } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";
import { SettingsHeaderAction } from "./settings-header";
import {
  searchSkills,
  inspectSkill,
  installSkill,
  listInstalledSkills,
  removeInstalledSkill,
  listProjects,
  type DiscoveredProject,
  type InstalledSkillRow,
  type SkillInspection,
  type SkillScanFinding,
  type SkillScanReport,
  type SkillScanSeverity,
  type SkillScanVerdict,
  type SkillScope,
  type SkillSearchHit,
  type SkillSearchResponse,
} from "./agent";
import { toast } from "./toast";
import { EmptyState } from "./EmptyState";

interface Props {
  onClose: () => void;
}

/**
 * Skill finder — Settings → Skills. Searches skills.sh (GitHub as fallback),
 * downloads a skill to a temp folder and shows what is in it plus a static
 * scan, then installs it into a project's `.gg/skills` or the global skills
 * folder. Nothing from the skill runs before the user installs it; a "block"
 * verdict needs an explicit, logged override.
 *
 * Scope follows McpModal: Global is every project; Project needs a path, picked
 * from the discovered projects or typed in.
 */
const SEARCH_DEBOUNCE_MS = 350;
const SEVERITIES: SkillScanSeverity[] = ["critical", "high", "medium", "low"];
/** Tools a skill may ask for that give it the run of the machine. */
const BROAD_TOOLS = /^(bash|shell|exec|execute|run|write|edit|delete|rm)\b|\*/i;

const mono = { fontFamily: "var(--mono)", fontSize: "var(--fs-xs)" } as const;

function verdictColor(verdict: SkillScanVerdict | undefined): string | undefined {
  if (verdict === "pass") return theme.success;
  if (verdict === "warn") return theme.warning;
  if (verdict === "block") return theme.error;
  return undefined;
}

function verdictLabel(verdict: SkillScanVerdict | undefined): string {
  if (verdict === "pass") return "No findings";
  if (verdict === "warn") return "Findings";
  if (verdict === "block") return "Blocked";
  return "Not scanned";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The scan's verdict banner and its findings, by severity. */
function ScanReport({ scan }: { scan: SkillScanReport }): React.ReactElement {
  const color = verdictColor(scan.verdict);
  const Icon =
    scan.verdict === "pass"
      ? CheckCircleIcon
      : scan.verdict === "warn"
        ? WarningCircleIcon
        : XCircleIcon;
  const headline =
    scan.verdict === "pass"
      ? `No findings, scanned with ${scan.rulesRun} rule${scan.rulesRun === 1 ? "" : "s"}`
      : scan.verdict === "warn"
        ? `Findings to read before you install: ${scan.summary}`
        : `Blocked: ${scan.summary}`;
  return (
    <div className="skills-scan">
      <div
        className="skills-scan-banner"
        role={scan.verdict === "block" ? "alert" : "status"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-3) var(--space-4)",
          borderRadius: "var(--radius-sm)",
          border: `1px solid ${color}`,
          color,
          fontSize: "var(--fs-sm)",
        }}
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
              style={{
                margin: 0,
                fontSize: "var(--fs-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: severity === "critical" || severity === "high" ? theme.error : theme.warning,
              }}
            >
              {severity} ({group.length})
            </h4>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.map((f: SkillScanFinding, i) => (
                <li
                  key={`${f.rule}:${f.file}:${f.line}:${i}`}
                  style={{
                    padding: "var(--space-2) 0",
                    borderBottom: `1px solid ${theme.border}`,
                    fontSize: "var(--fs-sm)",
                  }}
                >
                  <div style={{ color: theme.text }}>
                    <span style={{ ...mono, color: theme.textMuted }}>{f.rule}</span> {f.title}
                  </div>
                  <div style={{ ...mono, color: theme.textDim }}>
                    {f.file}:{f.line}
                  </div>
                  <div style={{ color: theme.textSecondary }}>{f.reason}</div>
                  {f.evidence && (
                    <pre
                      style={{
                        ...mono,
                        margin: "var(--space-1) 0 0",
                        padding: "var(--space-2)",
                        background: theme.surface1,
                        borderRadius: "var(--radius-sm)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        color: theme.text,
                      }}
                    >
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

export function SkillsModal({ onClose }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";

  // Search.
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<SkillSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // Inspection of the selected hit.
  const [selected, setSelected] = useState<SkillSearchHit | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<SkillInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // Install.
  const [scope, setScope] = useState<SkillScope>("global");
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);
  // Findings returned by a refused install (usually the same as the inspection's).
  const [refusedScan, setRefusedScan] = useState<SkillScanReport | null>(null);

  // Installed list (both scopes).
  const [installed, setInstalled] = useState<InstalledSkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [listCwd, setListCwd] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState<InstalledSkillRow | null>(null);
  useSettingsPageReady(!loading);

  const refresh = useCallback(async (cwd?: string): Promise<void> => {
    setLoading(true);
    setListCwd(cwd);
    try {
      setInstalled(await listInstalledSkills(cwd));
      setLoadError(false);
    } catch (e) {
      setLoadError(true);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => toast("Couldn't load your projects. Type the project path instead.", "warning"));
  }, []);

  // The installed list covers global plus the chosen project.
  useEffect(() => {
    if (scope === "project" && projectPath) void refresh(projectPath).catch(() => {});
    if (scope === "global") void refresh().catch(() => {});
  }, [scope, projectPath, refresh]);

  const runSearch = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    const seq = ++searchSeq.current;
    if (!trimmed) {
      setSearch(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const res = await searchSkills(trimmed);
      if (seq !== searchSeq.current) return;
      setSearch(res);
      setSearchError(null);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setSearchError(`Search failed: ${errorText(e)}`);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  // Debounced search as you type; Enter searches at once.
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  async function inspect(source: string, slug: string, hit?: SkillSearchHit): Promise<void> {
    if (hit) setSelected(hit);
    setInspecting(true);
    setInspection(null);
    setInspectError(null);
    setConfirmOverride(false);
    setRefusedScan(null);
    try {
      setInspection(await inspectSkill(source, slug));
    } catch (e) {
      setInspectError(`Couldn't inspect this skill: ${errorText(e)}`);
    } finally {
      setInspecting(false);
    }
  }

  async function install(override: boolean): Promise<void> {
    if (!inspection || installing) return;
    if (scope === "project" && !projectPath) {
      toast("Enter or pick a project path first.", "warning");
      return;
    }
    setInstalling(true);
    try {
      const cwd = scope === "project" ? projectPath : undefined;
      const result = await installSkill({
        source: inspection.source,
        slug: inspection.slug,
        scope,
        projectCwd: cwd,
        ...(override ? { override: true } : {}),
      });
      if (result.installed) {
        setConfirmOverride(false);
        setRefusedScan(null);
        toast(
          `Installed "${result.entry?.name ?? inspection.summary.name}"${
            scope === "project" ? " into this project" : ""
          }.`,
          "success",
        );
        await refresh(cwd);
      } else {
        setRefusedScan(result.scan ?? null);
        toast(result.error ?? "Israel Code refused to install this skill.", "warning");
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setInstalling(false);
    }
  }

  async function remove(row: InstalledSkillRow): Promise<void> {
    setConfirmRemove(null);
    try {
      const { removed } = await removeInstalledSkill(
        row.name,
        row.scope,
        row.scope === "project" ? (listCwd ?? (projectPath || undefined)) : undefined,
      );
      if (removed) {
        toast(`Removed "${row.name}".`, "success");
        await refresh(listCwd);
      } else {
        toast(`No "${row.name}" found.`, "warning");
      }
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const blocked = inspection?.scan.verdict === "block";
  const blockingCount =
    inspection?.scan.findings.filter((f) => f.severity === "critical" || f.severity === "high")
      .length ?? 0;
  const canInstall = !!inspection && !inspection.candidates && !installing && !blocked;

  const installButton = (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={!canInstall}
      title={
        blocked
          ? "The scan blocked this skill"
          : inspection?.candidates
            ? "Pick one skill from the repo first"
            : undefined
      }
      onClick={() => void install(false)}
    >
      {installing ? "Installing\u2026" : "Install"}
    </button>
  );

  // ── Search results ──────────────────────────────────────────────────────
  const results = (
    <>
      <label
        htmlFor="skills-search"
        className="modal-label"
        style={{ color: theme.textMuted, display: embedded ? "none" : undefined }}
      >
        Search
      </label>
      <input
        id="skills-search"
        className="modal-input"
        type="search"
        aria-label="Search skills"
        style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
        value={query}
        placeholder="Search skills, e.g. pdf, playwright, owner/repo"
        autoFocus={!embedded}
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
      {search?.notice && (
        <div className="modal-hint" style={{ color: theme.warning, marginTop: "var(--space-3)" }}>
          {search.notice}
        </div>
      )}
      {searching ? (
        <ListSkeleton rows={3} />
      ) : search && search.results.length === 0 ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          Nothing found for "{query.trim()}".
        </div>
      ) : search ? (
        <ul className="mcp-list" aria-label="Search results" style={{ listStyle: "none" }}>
          {search.results.map((hit) => {
            const isSelected = selected?.id === hit.id;
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  className="mcp-item"
                  aria-pressed={isSelected}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: isSelected ? theme.surface2 : undefined,
                    border: 0,
                    cursor: "pointer",
                    flexWrap: "wrap",
                  }}
                  onClick={() => void inspect(hit.source, hit.slug, hit)}
                >
                  <span className="mcp-name" style={{ color: theme.text }}>
                    {hit.name}
                  </span>
                  <span className="mcp-meta" style={{ ...mono, color: theme.textDim }}>
                    {hit.source}
                  </span>
                  {hit.installs !== undefined ? (
                    <span className="mcp-meta" style={{ color: theme.textDim }}>
                      {formatCount(hit.installs)} installs
                    </span>
                  ) : hit.stars !== undefined ? (
                    <span className="mcp-meta" style={{ color: theme.textDim }}>
                      {formatCount(hit.stars)} stars
                    </span>
                  ) : null}
                  <Badge>{hit.origin}</Badge>
                  {hit.audits?.map((a) => (
                    <Badge
                      key={a.provider}
                      color={/low|safe|pass|ok/i.test(a.risk) ? theme.success : theme.warning}
                      title={a.alerts !== undefined ? `${a.alerts} alerts` : undefined}
                    >
                      {a.provider}: {a.risk}
                    </Badge>
                  ))}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );

  // ── Detail + scan ───────────────────────────────────────────────────────
  const detail = (
    <>
      {inspecting ? (
        <ListSkeleton rows={4} />
      ) : inspectError ? (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {inspectError}
        </div>
      ) : !inspection ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          Pick a search result to see what it does and what the scan found.
        </div>
      ) : (
        <div className="skills-detail">
          <h4 style={{ margin: 0, color: theme.text }}>{inspection.summary.name}</h4>
          <div style={{ ...mono, color: theme.textDim }}>
            {inspection.source}
            {inspection.slug ? `/${inspection.slug}` : ""}
          </div>
          {inspection.summary.description && (
            <p style={{ color: theme.textSecondary, margin: "var(--space-3) 0" }}>
              {inspection.summary.description}
            </p>
          )}
          <dl
            className="skills-facts"
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "var(--space-1) var(--space-5)",
              margin: "var(--space-3) 0",
              fontSize: "var(--fs-sm)",
            }}
          >
            <dt style={{ color: theme.textMuted }}>Compatibility</dt>
            <dd style={{ margin: 0 }}>{inspection.summary.compatibility || "Not stated"}</dd>
            <dt style={{ color: theme.textMuted }}>License</dt>
            <dd style={{ margin: 0 }}>{inspection.summary.license || "Not stated"}</dd>
            <dt style={{ color: theme.textMuted }}>Allowed tools</dt>
            <dd style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {inspection.summary.allowedTools.length === 0
                ? "None listed"
                : inspection.summary.allowedTools.map((tool) => {
                    const broad = BROAD_TOOLS.test(tool);
                    return (
                      <Badge
                        key={tool}
                        color={broad ? theme.warning : undefined}
                        title={
                          broad ? "A broad tool: it can change files or run commands" : undefined
                        }
                      >
                        {tool}
                      </Badge>
                    );
                  })}
            </dd>
            <dt style={{ color: theme.textMuted }}>Contents</dt>
            <dd style={{ margin: 0 }}>
              {inspection.summary.fileCount} file{inspection.summary.fileCount === 1 ? "" : "s"},{" "}
              {formatBytes(inspection.summary.totalBytes)}
            </dd>
          </dl>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {inspection.summary.hasScripts && <Badge color={theme.warning}>Has scripts</Badge>}
            {inspection.summary.hasHooks && <Badge color={theme.warning}>Has hooks</Badge>}
            {inspection.summary.usesShellInjection && (
              <Badge color={theme.error}>Runs shell at load</Badge>
            )}
            {!inspection.summary.hasFrontmatter && <Badge>No frontmatter</Badge>}
          </div>

          {inspection.candidates && inspection.candidates.length > 0 && (
            <div style={{ marginTop: "var(--space-5)" }}>
              <div className="modal-hint" style={{ color: theme.textMuted }}>
                This repo holds {inspection.candidates.length} skills. Pick one to inspect.
              </div>
              <ul
                className="mcp-list"
                aria-label="Skills in this repo"
                style={{ listStyle: "none" }}
              >
                {inspection.candidates.map((c) => (
                  <li key={c.slug}>
                    <button
                      type="button"
                      className="mcp-item"
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: 0,
                        cursor: "pointer",
                      }}
                      onClick={() => void inspect(inspection.source, c.slug)}
                    >
                      <span className="mcp-name" style={{ color: theme.text }}>
                        {c.slug}
                      </span>
                      <span className="mcp-meta" style={{ ...mono, color: theme.textDim }}>
                        {c.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ marginTop: "var(--space-5)" }}>
            <ScanReport scan={refusedScan ?? inspection.scan} />
          </div>

          {blocked && !inspection.candidates && !confirmOverride && (
            <div style={{ marginTop: "var(--space-4)", fontSize: "var(--fs-sm)" }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ color: theme.textMuted, textDecoration: "underline" }}
                onClick={() => setConfirmOverride(true)}
              >
                Install anyway
              </button>
            </div>
          )}
          {confirmOverride && (
            <div
              role="alertdialog"
              aria-labelledby="skills-override-title"
              style={{
                marginTop: "var(--space-4)",
                padding: "var(--space-4)",
                border: `1px solid ${theme.error}`,
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--fs-sm)",
              }}
            >
              <p id="skills-override-title" style={{ margin: 0, color: theme.text }}>
                You are about to install despite {blockingCount} blocking finding
                {blockingCount === 1 ? "" : "s"}. Israel Code will not vouch for this skill.
              </p>
              <div className="modal-actions" style={{ marginTop: "var(--space-4)" }}>
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
                  disabled={installing}
                  onClick={() => void install(true)}
                >
                  {installing ? "Installing\u2026" : "Install despite findings"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );

  // ── Scope ───────────────────────────────────────────────────────────────
  const scopePicker = (
    <>
      <div className="mcp-scope-toggle" role="group" aria-label="Install scope">
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
            list="skills-project-paths"
            onChange={(e) => setProjectPath(e.target.value)}
          />
          <datalist id="skills-project-paths">
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </datalist>
        </>
      )}
    </>
  );

  // ── Installed ───────────────────────────────────────────────────────────
  const installedList = loading ? (
    <ListSkeleton rows={3} />
  ) : loadError ? (
    <div className="picker-empty" role="alert">
      <span style={{ color: theme.textMuted }}>Couldn't reach the agent to list skills.</span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => void refresh(listCwd).catch(() => {})}
      >
        Try again
      </button>
    </div>
  ) : installed.length === 0 ? (
    <EmptyState
      className="mcp-empty"
      message="No skills installed yet. Skills teach the agent a job, like reading PDFs."
    >
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => document.getElementById("skills-search")?.focus()}
      >
        Search skills
      </button>
    </EmptyState>
  ) : (
    <ul className="mcp-list" aria-label="Installed skills" style={{ listStyle: "none" }}>
      {installed.map((row) => (
        <li className="mcp-entry" key={`${row.scope}:${row.name}`}>
          <div className="mcp-item" style={{ flexWrap: "wrap" }}>
            <span className="mcp-name" style={{ color: theme.text }} title={row.path}>
              {row.name}
            </span>
            <Badge>{row.scope === "project" ? "Project" : "Global"}</Badge>
            {row.source && (
              <span className="mcp-meta" style={{ ...mono, color: theme.textDim }}>
                {row.source}
              </span>
            )}
            {row.installedAt && (
              <span className="mcp-meta" style={{ color: theme.textDim }}>
                {new Date(row.installedAt).toLocaleDateString()}
              </span>
            )}
            <Badge color={verdictColor(row.verdict)}>{verdictLabel(row.verdict)}</Badge>
            {row.overridden && (
              <Badge color={theme.error} title="You chose to install despite blocking findings">
                Installed despite findings
              </Badge>
            )}
            <button
              type="button"
              className="mcp-delete"
              style={{ color: theme.textDim }}
              aria-label={`Remove ${row.name}`}
              title={`Remove "${row.name}"`}
              onClick={() => setConfirmRemove(row)}
            >
              <XIcon size={12} weight="bold" aria-hidden="true" />
            </button>
          </div>
          {confirmRemove?.name === row.name && confirmRemove.scope === row.scope && (
            <div
              role="alertdialog"
              aria-label={`Remove ${row.name}?`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4)",
                padding: "var(--space-2) var(--space-4)",
                fontSize: "var(--fs-sm)",
                color: theme.textSecondary,
              }}
            >
              <span>
                Remove "{row.name}" from{" "}
                {row.scope === "project" ? "this project" : "every project"}?
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                autoFocus
                onClick={() => setConfirmRemove(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void remove(row)}
              >
                Remove
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Modal title="Skills" onClose={onClose}>
      <div className="settings-cols">
        <div className="settings-col">
          <SettingsSection
            title="Find a skill"
            dialogTitle="Find a skill"
            description="Search skills.sh. Each result is downloaded and scanned before you install it; nothing runs."
          >
            {results}
          </SettingsSection>
          {embedded ? (
            <SettingsCard
              title="Installed"
              description="Skills your agent can use, global and in the chosen project."
            >
              {installedList}
            </SettingsCard>
          ) : (
            <>
              <div
                className="modal-label"
                style={{ color: theme.textMuted, marginTop: "var(--space-6)" }}
              >
                Installed
              </div>
              {installedList}
            </>
          )}
        </div>
        <div className="settings-col">
          {embedded && <SettingsHeaderAction>{installButton}</SettingsHeaderAction>}
          <SettingsSection
            title="About this skill"
            dialogTitle="About this skill"
            description="What it does, what it asks for, and what the scan found."
          >
            {detail}
          </SettingsSection>
          <SettingsSection
            title="Install to"
            dialogTitle="Install to"
            description="Global is every project (~/.israelcode/skills). Project puts it in that project's .gg/skills."
          >
            {scopePicker}
          </SettingsSection>
          {!embedded && (
            <div className="modal-actions">
              <ModalDismissButton onClick={onClose}>Close</ModalDismissButton>
              {installButton}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
