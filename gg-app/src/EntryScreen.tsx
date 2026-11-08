import { Suspense, type Dispatch, type ReactElement, type SetStateAction } from "react";
import type { BackgroundSessionRow, WorkspaceMode } from "./agent";
import type { EntryView } from "./app-entry-view";
import { ChatPicker } from "./ChatPicker";
import { HomeScreen } from "./HomeScreen";
import { ProjectPicker } from "./ProjectPicker";
import { SettingsScreen, type SettingsTabId } from "./SettingsScreen";
import { GoalPicker } from "./LazyGoalPicker";
import { showScreen } from "./view-transition";

/**
 * The screen a window shows before it has a workspace: Home, Settings, or the
 * project, goal, chat or motion session picker. Presentational; App.tsx owns
 * the state.
 */
export function EntryScreen({
  entryView,
  setEntryView,
  setWorkspaceMode,
  worldComputer,
  setWorldComputer,
  setShowWorld,
  worldShown,
  settingsTab,
  setSettingsTab,
  homeRefreshSignal,
  setHomeRefreshSignal,
  onOpenBackground,
  onChosen,
}: {
  entryView: EntryView;
  setEntryView: Dispatch<SetStateAction<EntryView>>;
  setWorkspaceMode: Dispatch<SetStateAction<WorkspaceMode>>;
  worldComputer: boolean;
  setWorldComputer: Dispatch<SetStateAction<boolean>>;
  setShowWorld: Dispatch<SetStateAction<boolean>>;
  worldShown: boolean;
  settingsTab: SettingsTabId;
  setSettingsTab: Dispatch<SetStateAction<SettingsTabId>>;
  homeRefreshSignal: number;
  setHomeRefreshSignal: Dispatch<SetStateAction<number>>;
  onOpenBackground: (row: BackgroundSessionRow) => Promise<void>;
  onChosen: () => void;
}): ReactElement {
  return (
    <>
      {entryView === "home" || entryView === "world" ? (
        <HomeScreen
          onProjects={() =>
            showScreen(() => {
              setWorkspaceMode("code");
              setEntryView("projects");
            })
          }
          onGoals={() =>
            showScreen(() => {
              setWorkspaceMode("code");
              setEntryView("goals");
            })
          }
          onChat={() =>
            showScreen(() => {
              setWorkspaceMode("chat");
              setEntryView("chats");
            })
          }
          onMotion={() =>
            showScreen(() => {
              setWorkspaceMode("motion");
              setEntryView("motion");
            })
          }
          // On the in-game computer World is already open behind it: World just stands the player up.
          onWorld={() =>
            worldComputer ? setWorldComputer(false) : showScreen(() => setShowWorld(true))
          }
          worldShown={worldShown}
          onSettings={(tab) =>
            showScreen(() => {
              setSettingsTab(tab ?? "general");
              setEntryView("settings");
            })
          }
          refreshSignal={homeRefreshSignal}
          onOpenBackground={onOpenBackground}
        />
      ) : entryView === "settings" ? (
        <SettingsScreen
          initialTab={settingsTab}
          onClose={() =>
            showScreen(() => {
              setEntryView("home");
              // Settings may have changed the folder or providers.
              setHomeRefreshSignal((n) => n + 1);
            })
          }
        />
      ) : entryView === "goals" ? (
        <Suspense fallback={null}>
          <GoalPicker onChosen={onChosen} onClose={() => showScreen(() => setEntryView("home"))} />
        </Suspense>
      ) : entryView === "chats" ? (
        <ChatPicker onChosen={onChosen} onClose={() => showScreen(() => setEntryView("home"))} />
      ) : entryView === "motion" ? (
        <ChatPicker
          mode="motion"
          onChosen={onChosen}
          onClose={() => showScreen(() => setEntryView("home"))}
        />
      ) : (
        <ProjectPicker
          onChosen={onChosen}
          // Every window can return to the mode-neutral home screen.
          onClose={() => showScreen(() => setEntryView("home"))}
        />
      )}
    </>
  );
}
