import {
  getSettings,
  listProjects,
  listSessions,
  waitForReady,
  type ChatAgentId,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";

/** One row of Home's "Jump back in": a project session or a chat. */
export interface HomeRecent {
  kind: "code" | "chat";
  /** The project folder (code) or the projects root the chats live in (chat). */
  cwd: string;
  /** Project name, or "Chat · <agent>". */
  where: string;
  session: RecentSession;
}

const AGENT_NAMES: Record<ChatAgentId, string> = {
  general: "General",
  therapist: "Therapist",
  research: "Research",
};

export function chatWhere(agent: ChatAgentId | undefined): string {
  return `Chat \u00b7 ${AGENT_NAMES[agent ?? "general"] ?? AGENT_NAMES.general}`;
}

export function recentTitle(session: RecentSession): string {
  return session.preview.trim() || "Untitled conversation";
}

/** The `count` most recently active projects (server order when times are missing). */
export function pickRecentProjects(
  projects: readonly DiscoveredProject[],
  count: number,
): DiscoveredProject[] {
  return projects
    .map((project, index) => ({ project, index }))
    .sort(
      (a, b) =>
        (b.project.lastActiveMs ?? -1) - (a.project.lastActiveMs ?? -1) || a.index - b.index,
    )
    .slice(0, count)
    .map((entry) => entry.project);
}

/**
 * Newest first across every list. Rows without a time (an older sidecar) keep
 * their list's order after the timed ones; a session listed twice shows once.
 */
export function mergeRecents(groups: readonly HomeRecent[][], limit = 4): HomeRecent[] {
  const seen = new Set<string>();
  const rows: Array<{ row: HomeRecent; index: number }> = [];
  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.session.path)) continue;
      seen.add(row.session.path);
      rows.push({ row, index: rows.length });
    }
  }
  return rows
    .sort(
      (a, b) =>
        (b.row.session.lastActiveMs ?? -1) - (a.row.session.lastActiveMs ?? -1) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * The latest sessions of the 3 most recent projects plus every chat, merged.
 * One list failing leaves the others; only all of them failing is an error.
 */
export async function loadHomeRecents(limit = 4): Promise<HomeRecent[]> {
  const settings = await getSettings().catch(() => null);
  const root = settings?.projectsRoot.trim() ?? "";
  await waitForReady();
  let firstError: unknown = null;
  const failed = (e: unknown): null => {
    firstError ??= e;
    return null;
  };
  const projects = await listProjects().catch(failed);
  const loads: Array<Promise<HomeRecent[] | null>> = pickRecentProjects(projects ?? [], 3).map(
    (project) =>
      listSessions(project.path)
        .then((sessions) =>
          sessions.map((session): HomeRecent => ({
            kind: "code",
            cwd: project.path,
            where: project.name,
            session,
          })),
        )
        .catch(failed),
  );
  if (root) {
    loads.push(
      listSessions(root, "all")
        .then((sessions) =>
          sessions.map((session): HomeRecent => ({
            kind: "chat",
            cwd: root,
            where: chatWhere(session.chatAgent),
            session,
          })),
        )
        .catch(failed),
    );
  }
  const groups = await Promise.all(loads);
  const ok = groups.filter((g): g is HomeRecent[] => g !== null);
  if (ok.length === 0 && firstError !== null) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  return mergeRecents(ok, limit);
}
