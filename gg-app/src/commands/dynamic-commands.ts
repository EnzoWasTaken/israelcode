import {
  listModels,
  listProjects,
  listSessions,
  type ModelOption,
  type RecentSession,
  type WorkspaceMode,
} from "../agent";
import type { Command } from "./command-registry";

/** Lists the palette fetches when it opens; each resolves on its own. */
export type CommandLoader = () => Promise<Command[]>;

export function projectCommands(open: (path: string) => void): CommandLoader {
  return async () =>
    (await listProjects()).map((p) => ({
      id: `project:${p.path}`,
      title: p.name,
      section: "Projects",
      detail: p.lastActiveDisplay,
      keywords: p.path,
      run: () => open(p.path),
    }));
}

/** Recent sessions of this workspace that open directly (not imported ones). */
export function sessionCommands(
  cwd: string,
  mode: WorkspaceMode,
  open: (session: RecentSession) => void,
): CommandLoader {
  return async () => {
    const agent = mode === "chat" ? "all" : mode === "motion" ? "motion" : undefined;
    return (await listSessions(cwd, agent))
      .filter((s) => !s.source || s.source === "ggcoder")
      .slice(0, 30)
      .map((s) => ({
        id: `session:${s.path}`,
        title: s.preview.trim() || "Untitled session",
        section: "Sessions",
        detail: s.lastActiveDisplay,
        run: () => open(s),
      }));
  };
}

export function modelCommands(
  current: string | undefined,
  select: (model: ModelOption) => void,
): CommandLoader {
  return async () =>
    ((await listModels()) ?? [])
      .filter((m) => m.supportsTools !== false)
      .map((m) => ({
        id: `model:${m.id}`,
        title: m.name,
        section: "Models",
        detail: m.id === current ? "current" : (m.endpoint ?? m.provider),
        keywords: `${m.id} ${m.provider}`,
        run: () => select(m),
      }));
}
