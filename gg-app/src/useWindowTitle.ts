import { useEffect } from "react";
import { setWindowTitle, workspaceProductName, type AgentState, type WorkspaceMode } from "./agent";
import { formatWorkspaceTitle } from "./workspace-title";

/** Keep the native window title aligned with the visible title-bar context. */
export function useWindowTitle({
  needsProject,
  showPicker,
  state,
  workspaceMode,
}: {
  needsProject: boolean;
  showPicker: boolean;
  state: AgentState | null;
  workspaceMode: WorkspaceMode;
}): void {
  useEffect(() => {
    const fallbackTitle = workspaceProductName(workspaceMode, Boolean(state?.goal));
    const title =
      !needsProject && !showPicker && state?.goal
        ? `${state.goal.name} · ${fallbackTitle}`
        : !needsProject && !showPicker
          ? formatWorkspaceTitle(
              state?.cwd,
              state?.gitBranch,
              fallbackTitle,
              state?.gitDirtyFileCount,
              state?.gitHubIssues ?? null,
              state?.gitHubPRs ?? null,
            )
          : fallbackTitle;
    setWindowTitle(title);
  }, [
    needsProject,
    showPicker,
    state?.cwd,
    state?.gitBranch,
    state?.gitDirtyFileCount,
    state?.gitHubIssues,
    state?.gitHubPRs,
    state?.goal,
    workspaceMode,
  ]);
}
