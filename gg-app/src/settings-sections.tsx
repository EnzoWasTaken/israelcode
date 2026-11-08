import { useEffect, useState } from "react";
import {
  ShieldCheckIcon,
  GearSixIcon,
  InfoIcon,
  KeyIcon,
  PuzzlePieceIcon,
  SparkleIcon,
  PaperPlaneTiltIcon,
  SyringeIcon,
  PathIcon,
  LightningIcon,
  StackIcon,
  CoinsIcon,
  BugBeetleIcon,
  type Icon,
} from "./phosphor-icons";
import { Badge } from "./Badge";
import { EmbeddedModal } from "./modal-embed";
import { SettingsModal } from "./SettingsModal";
import { LoginScreen } from "./LoginScreen";
import { TelegramSettingsModal } from "./TelegramSettingsModal";
import { McpModal } from "./McpModal";
import { SkillsModal } from "./SkillsModal";
import { HooksPanel } from "./HooksPanel";
import { SteroidsModal } from "./SteroidsModal";
import { SettingsAutoRouting } from "./SettingsAutoRouting";
import { SettingsExecutionModes } from "./SettingsExecutionModes";
import { SettingsSessions } from "./SettingsSessions";
import { SettingsCost } from "./SettingsCost";
import { SettingsDiagnostics } from "./SettingsDiagnostics";
import { AboutPage } from "./AboutPage";
import { useSettingsPageReady } from "./settings-ready";
import { SettingsHeaderAction, SettingsHeaderStatus } from "./settings-header";
import {
  waitForReady,
  hasModelSource,
  getServeStatus,
  startServe,
  stopServe,
  setRemoteActive,
  type SteroidsStatus,
} from "./agent";
import { theme } from "./theme";
import { toast } from "./toast";

/**
 * The Settings section registry. To add a page: widen `SettingsTabId`, add one
 * entry to SETTINGS_SECTIONS (and a group to SETTINGS_GROUPS if it needs a new
 * one). SettingsScreen renders the nav, header, description and page from it.
 */
export type SettingsTabId =
  | "general"
  | "providers"
  | "auto-routing"
  | "execution-modes"
  | "sessions"
  | "cost"
  | "remote"
  | "mcp"
  | "skills"
  | "hooks"
  | "steroids"
  | "diagnostics"
  | "about";

/** State the screen shares with section renderers and alert predicates. */
export interface SettingsContext {
  steroids: SteroidsStatus | null;
  setSteroids: (status: SteroidsStatus | null) => void;
  /** Pages stay put after their own Save/Close (the Back button leaves). */
  stay: () => void;
  /** Open another Settings page (for "Edit in Auto routing" links). */
  goTo: (id: SettingsTabId) => void;
}

export interface SettingsSection {
  id: SettingsTabId;
  /** Nav label, and the page's heading. */
  label: string;
  group: SettingsGroupId;
  icon: Icon;
  /** One line under the heading. */
  description: string;
  render: (ctx: SettingsContext) => React.ReactElement;
  /** A small dot on the nav entry: something here needs attention. */
  alert?: (ctx: SettingsContext) => boolean;
  /** The page fills the window and scrolls its own regions (AI Providers). */
  fill?: boolean;
}

export type SettingsGroupId = "app" | "models" | "integrations" | "advanced" | "help";

/** Nav groups, in order. An empty label draws no heading. */
export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; label: string }> = [
  { id: "app", label: "App" },
  { id: "models", label: "Models" },
  { id: "integrations", label: "Integrations" },
  { id: "advanced", label: "Advanced" },
  { id: "help", label: "" },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    label: "General",
    group: "app",
    icon: GearSixIcon,
    description: "Appearance, effects and your project folder.",
    render: ({ stay }) => (
      <EmbeddedModal>
        <SettingsModal onClose={stay} onSaved={() => toast("Project folder saved.", "success")} />
      </EmbeddedModal>
    ),
  },
  {
    id: "providers",
    label: "AI Providers",
    group: "models",
    icon: KeyIcon,
    description: "Connect the accounts and keys your agents use.",
    fill: true,
    render: () => <LoginScreen />,
  },
  {
    id: "auto-routing",
    label: "Auto routing",
    group: "models",
    icon: PathIcon,
    description: "Let Auto pick the model, effort and mode for each prompt.",
    render: () => <SettingsAutoRouting />,
  },
  {
    id: "execution-modes",
    label: "Execution modes",
    group: "models",
    icon: LightningIcon,
    description: "Standard, Ultracode and Orchestrate: how a run is carried out.",
    render: ({ goTo }) => <SettingsExecutionModes onOpenAutoRouting={() => goTo("auto-routing")} />,
  },
  {
    id: "cost",
    label: "Cost & usage",
    group: "models",
    icon: CoinsIcon,
    description: "Where Auto limits cost and where token budgets are set.",
    render: ({ goTo }) => <SettingsCost onOpenAutoRouting={() => goTo("auto-routing")} />,
  },
  {
    id: "sessions",
    label: "Sessions & background",
    group: "app",
    icon: StackIcon,
    description: "Tasks that keep running, and what closing a window does.",
    render: () => <SettingsSessions />,
  },
  {
    id: "remote",
    label: "Remote",
    group: "integrations",
    icon: PaperPlaneTiltIcon,
    description: "Message your agent from your phone through a Telegram bot.",
    render: () => <RemotePage />,
  },
  {
    id: "mcp",
    label: "MCP",
    group: "integrations",
    icon: PuzzlePieceIcon,
    description: "Servers that give your agents extra tools.",
    render: ({ stay }) => (
      <EmbeddedModal>
        <McpModal onClose={stay} />
      </EmbeddedModal>
    ),
  },
  {
    id: "skills",
    label: "Skills",
    group: "integrations",
    icon: SparkleIcon,
    description: "Reusable instructions your agents can pick up.",
    render: ({ stay }) => (
      <EmbeddedModal>
        <SkillsModal onClose={stay} />
      </EmbeddedModal>
    ),
  },
  {
    id: "hooks",
    label: "Hooks",
    group: "integrations",
    icon: ShieldCheckIcon,
    description: "Commands that run around tool calls.",
    render: () => <HooksPanel />,
  },
  {
    id: "steroids",
    label: "Steroids",
    group: "integrations",
    icon: SyringeIcon,
    description: "Connect the Steroids companion.",
    alert: ({ steroids }) => steroids !== null && !steroids.connected,
    render: ({ steroids, setSteroids, stay }) => (
      <EmbeddedModal>
        <SteroidsModal status={steroids} onStatus={setSteroids} onClose={stay} />
      </EmbeddedModal>
    ),
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "advanced",
    icon: BugBeetleIcon,
    description: "Recent Auto routing decisions and where the app log lives.",
    render: () => <SettingsDiagnostics />,
  },
  {
    id: "about",
    label: "About",
    group: "help",
    icon: InfoIcon,
    description: "Version, licence and source.",
    render: () => <AboutPage />,
  },
];

/**
 * Remote: serve this machine to your Telegram bot (formerly the home screen's
 * Remote button). Start/stop sits in the header bar; the page is the bot's
 * setup.
 */
function RemotePage(): React.ReactElement {
  const [serving, setServing] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  // Live/Off and the start button would flip once the status lands.
  const [loaded, setLoaded] = useState(false);
  useSettingsPageReady(loaded);

  async function refresh(): Promise<void> {
    await waitForReady();
    const serve = await getServeStatus();
    setServing(serve.running);
    setConfigured(serve.configured);
  }

  useEffect(() => {
    void refresh()
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!serving) {
        // The bot hands messages to an agent, so serving needs a provider.
        if (!(await hasModelSource())) {
          toast("Connect an AI provider first.", "warning");
          return;
        }
      }
      if (serving) {
        await stopServe();
        setServing(false);
        // Keep the macOS tray's Remote label in step.
        void setRemoteActive(false);
        toast("Stopped serving.", "success");
      } else {
        await startServe();
        setServing(true);
        void setRemoteActive(true);
        toast("Serving on Telegram — message your bot.", "success");
      }
    } catch (e) {
      toast(`Serve failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Start/stop lives in the header bar and Live/Off beside the page name, so
    // the page itself is just the bot's setup.
    <>
      <SettingsHeaderStatus>
        <Badge color={serving ? theme.success : undefined}>{serving ? "Live" : "Off"}</Badge>
      </SettingsHeaderStatus>
      <SettingsHeaderAction>
        <button
          className={serving ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
          type="button"
          disabled={busy || (!serving && !configured)}
          title={
            !serving && !configured ? "Save your bot first" : "Message your agent from your phone"
          }
          onClick={() => void toggle()}
        >
          {busy ? "Working\u2026" : serving ? "Stop serving" : "Start serving"}
        </button>
      </SettingsHeaderAction>
      <EmbeddedModal>
        <TelegramSettingsModal onClose={() => {}} onSaved={() => void refresh().catch(() => {})} />
      </EmbeddedModal>
    </>
  );
}
