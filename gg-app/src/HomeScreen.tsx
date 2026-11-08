import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { HomeLaunchpad, type HomeMode } from "./HomeLaunchpad";
import {
  ChatCircleIcon,
  FilmStripIcon,
  GlobeHemisphereWestIcon,
  TargetIcon,
  TerminalIcon,
} from "./phosphor-icons";
import { getVersion } from "@tauri-apps/api/app";
import { error as logError } from "@tauri-apps/plugin-log";
import { HomeTitle } from "./HomeTitle";
import { PixelIconButton } from "./PixelIconButton";
import { PixelTip } from "./PixelTip";
import { HomeScenery, withScenery } from "./HomeScenery";
import { HomeCritters } from "./HomeCritters";
import { HomeUpdateButton } from "./HomeUpdateButton";
import { useHomeBackgroundEnabled } from "./home-background";
import { groundFilter, lightAt } from "./scene-light";
import { useLocalHour } from "./use-local-hour";
import { useRandomBiome } from "./use-random-biome";
import type { SettingsTabId } from "./SettingsScreen";
import {
  waitForReady,
  getSettings,
  hasModelSource,
  openWhatsNewWindow,
  setRemoteActive,
  type BackgroundSessionRow,
  getServeStatus,
} from "./agent";
import { useAppUpdate } from "./update";
import { toast } from "./toast";
import { fl } from "./flavor";

// A failed setup check leaves the workspace buttons dimmed, so leave a trace in
// the app log instead of failing silently. The next focus retries.
function logSetupCheckFailure(e: unknown): Promise<void> {
  return logError(`Home setup check failed: ${String(e)}`);
}

interface Props {
  onProjects: () => void;
  onGoals: () => void;
  onChat: () => void;
  onMotion: () => void;
  /** Shows World full-window. */
  onWorld: () => void;
  /**
   * World is on screen (it fades in over Home once the game is ready).
   * Until then the World plate stays pressed, so the click visibly took.
   */
  worldShown?: boolean;
  /** Opens full-screen Settings, optionally on a given tab. */
  onSettings: (tab?: SettingsTabId) => void;
  /**
   * Bumped when something OUTSIDE this screen changed serve/auth state (the
   * macOS tray toggling Remote, or its Settings modal saving a projects
   * folder). A counter, not a boolean, so repeats always re-fire.
   */
  refreshSignal?: number;
  /**
   * Quick start or a recent row pointed this window at a session of this kind:
   * show the workspace. A typed first message is queued (first-prompt.ts).
   */
  onOpened?: (mode: "code" | "chat") => void;
  /** Reopen a background conversation in this window. */
  onOpenBackground?: (row: BackgroundSessionRow) => Promise<void> | void;
}

/**
 * App entry screen: the shimmering GG Coder banner over the primary actions.
 * Code, Chat and Motion require a configured workspace folder and connected AI provider;
 * World (the local game) needs neither, so it is never dimmed;
 * everything else lives in full-screen Settings (the bottom-right gear).
 */
export function HomeScreen({
  onProjects,
  onGoals,
  onChat,
  onMotion,
  onWorld,
  worldShown = false,
  onSettings,
  refreshSignal = 0,
  onOpenBackground,
  onOpened,
}: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerConnected, setProviderConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  // The version row stays hidden until the version is read, so What's new
  // never shifts sideways when the number arrives.
  const [versionRead, setVersionRead] = useState(false);
  const appUpdate = useAppUpdate();
  const worldNoteId = useId();
  // Held down from the moment World starts opening until it's on screen.
  const [worldOpening, setWorldOpening] = useState(false);
  useEffect(() => {
    if (worldShown) setWorldOpening(false);
  }, [worldShown]);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {})
      .finally(() => setVersionRead(true));
  }, []);

  async function refresh(): Promise<void> {
    // Settings + auth are read NATIVELY (Rust) — do them first, WITHOUT waiting on
    // the sidecar, so the workspace gate never stays dimmed just because the
    // agent is slow/crashed.
    const [settings, connected] = await Promise.all([getSettings(), hasModelSource()]);
    // Prefer the explicit `configured` flag; fall back to a non-empty root so an
    // older sidecar (one that predates the flag) degrades to "set" instead of
    // dimming forever.
    setFolderSet(settings?.configured ?? Boolean(settings?.projectsRoot));
    setProviderConnected(connected);
    // Keep the macOS tray's Remote label in step with the sidecar (it may have
    // respawned). Best-effort, and never blocks the native reads above.
    void waitForReady()
      .then(() => getServeStatus())
      .then((serve) => void setRemoteActive(serve.running))
      .catch(() => {});
  }

  useEffect(() => {
    void refresh().catch(logSetupCheckFailure);
    // Re-check when the window regains focus so a folder/provider set elsewhere
    // (or after a sidecar respawn) reflects without an app restart.
    const onFocus = (): void => void refresh().catch(logSetupCheckFailure);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Skips the initial 0 so mounting doesn't double-refresh.
  useEffect(() => {
    if (refreshSignal > 0) void refresh().catch(logSetupCheckFailure);
  }, [refreshSignal]);

  const ready = folderSet && providerConnected;

  function handleWorkspace(open: () => void): void {
    if (ready) {
      open();
      return;
    }
    // Take the user to the missing prerequisite: the folder first (General),
    // then a provider.
    if (!folderSet) {
      toast(fl("Set a workspace folder first.", "Nu, pick a workspace folder first."), "warning");
      onSettings("general");
    } else if (!providerConnected) {
      toast(
        fl("Connect an AI provider first.", "Connect an AI provider first. We're not magicians."),
        "warning",
      );
      onSettings("providers");
    }
  }

  const backgroundOn = useHomeBackgroundEnabled();
  // The critters' terrain for this visit. With the scenery on it has to be one
  // with a horizon painted behind it, and its ground takes the sky's light.
  const [visitBiome] = useRandomBiome();
  const biome = backgroundOn ? withScenery(visitBiome) : visitBiome;
  const hour = useLocalHour();
  const sceneStyle = useMemo(
    (): (CSSProperties & Record<"--scene-ground", string>) | undefined =>
      backgroundOn ? { "--scene-ground": groundFilter(lightAt(hour)) } : undefined,
    [backgroundOn, hour],
  );

  const modes: HomeMode[] = [
    {
      id: "code",
      label: "Code",
      icon: TerminalIcon,
      shortcut: "homeCode",
      tip: fl(
        "Code: open a project and build it with the agent.",
        "Code: open a project and build it with the agent. Yalla.",
      ),
      dimmed: !ready,
      onClick: () => handleWorkspace(onProjects),
    },
    {
      id: "goals",
      label: "Goals",
      icon: TargetIcon,
      shortcut: "homeGoals",
      tip: fl(
        "Goals: hand over a bigger goal and let a team of agents work on it.",
        "Goals: hand over a bigger goal to a team of agents. They argue, then it gets done.",
      ),
      dimmed: !ready,
      onClick: () => handleWorkspace(onGoals),
    },
    {
      id: "chat",
      label: "Chat",
      icon: ChatCircleIcon,
      shortcut: "homeChat",
      tip: fl(
        "Chat: talk things through, no project needed.",
        "Chat: talk things through, no project needed. Like a café, minus the bill.",
      ),
      dimmed: !ready,
      onClick: () => handleWorkspace(onChat),
    },
    {
      id: "motion",
      label: "Motion",
      icon: FilmStripIcon,
      shortcut: "homeMotion",
      tip: fl(
        "Motion: make videos and animations.",
        "Motion: make videos and animations. Eurovision-grade optional.",
      ),
      dimmed: !ready,
      onClick: () => handleWorkspace(onMotion),
    },
    {
      // World: the local 3D game, full-window in this window; new, so it
      // carries a New tag. While it loads (it takes a moment to build the
      // scene) the tag shows three pulsing pixel dots, so Home never looks frozen.
      id: "world",
      label: worldOpening ? "Loading" : "World",
      icon: GlobeHemisphereWestIcon,
      shortcut: "homeWorld",
      tip: "World: a cozy 3D hangout for coders, with your coding level and an optional online save.",
      busy: worldOpening,
      describedBy: worldNoteId,
      onClick: () => {
        setWorldOpening(true);
        onWorld();
      },
      tag: (
        <span id={worldNoteId} className={`home-action-beta${worldOpening ? " is-loading" : ""}`}>
          {worldOpening ? (
            <span className="home-loading-dots" aria-label="Loading World">
              <i />
              <i />
              <i />
            </span>
          ) : (
            "New"
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="home" data-tauri-drag-region style={sceneStyle}>
      {backgroundOn && <HomeScenery hour={hour} />}
      {/* Above the banner: the running version, and what's new in it. */}
      <div className={`home-version-row${versionRead ? "" : " is-pending"}`}>
        {version && (
          <>
            <span className="home-version">{`v${version}`}</span>
            <span className="home-version-sep" aria-hidden="true">
              {"\u00b7"}
            </span>
          </>
        )}
        <PixelTip text="What's new: the latest updates, and everything since.">
          <button
            className="home-whatsnew"
            type="button"
            onClick={() => void openWhatsNewWindow("calm").catch(() => {})}
          >
            What&apos;s new
          </button>
        </PixelTip>
      </div>
      <HomeTitle />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <HomeLaunchpad
        ready={ready}
        onNeedsSetup={() => handleWorkspace(() => {})}
        onOpened={(mode) => onOpened?.(mode)}
        modes={modes}
        onOpenBackground={onOpenBackground}
      />
      {/* Settings: a GG Royale pixel gear. */}
      <PixelTip
        text={fl(
          "Settings: AI providers, your projects folder, and more.",
          "Settings: AI providers, your projects folder, and the Humour switch (we won't be offended).",
        )}
      >
        <PixelIconButton
          className="home-settings"
          icon="gear"
          label="Settings"
          onClick={() => onSettings()}
        />
      </PixelTip>
      {/* Along the bottom edge: every critter, out playing. */}
      <HomeCritters biome={biome} />
      {/* Top centre: the update button, only while an update is out. */}
      <div className="home-version-corner">
        <HomeUpdateButton appUpdate={appUpdate} current={version} />
      </div>
    </div>
  );
}
