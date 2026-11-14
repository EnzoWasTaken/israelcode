import type { SettingsTabId } from "../settings-sections";

/**
 * Settings pages, in nav order. A plain copy so the palette doesn't load the
 * Settings screen's code; command-registry.test.ts fails if it drifts from
 * SETTINGS_SECTIONS.
 */
export const SETTINGS_PAGES: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "sessions", label: "Sessions & background" },
  { id: "providers", label: "AI providers" },
  { id: "auto-routing", label: "Auto routing" },
  { id: "execution-modes", label: "Execution modes" },
  { id: "cost", label: "Cost & usage" },
  { id: "remote", label: "Remote" },
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "hooks", label: "Hooks" },
  { id: "steroids", label: "Steroids" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "about", label: "About" },
];

/**
 * The one registry of what you can do from the keyboard. The command palette
 * lists `buildCommands`; the shortcuts sheet lists `SHORTCUTS`; every command
 * row shows its key from `SHORTCUTS`, so the two can't drift.
 */

export type CommandSection =
  | "This session"
  | "Navigation"
  | "Windows"
  | "View"
  | "Projects"
  | "Sessions"
  | "Models"
  | "Settings"
  | "Help";
export const SECTION_ORDER: readonly CommandSection[] = [
  "This session",
  "Navigation",
  "Windows",
  "View",
  "Projects",
  "Sessions",
  "Models",
  "Help",
  "Settings",
];

/** One key press. `mod` is ⌘ on macOS and Ctrl elsewhere; `ctrl` is Ctrl everywhere. */
export interface KeyCombo {
  mod?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export type ShortcutGroup = "Composer" | "Navigation" | "Windows" | "View" | "Dialogs";
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "Composer",
  "Navigation",
  "Windows",
  "View",
  "Dialogs",
];

export interface ShortcutDef {
  label: string;
  group: ShortcutGroup;
  /** Pressed in order (Escape twice is two combos). */
  keys: readonly KeyCombo[];
}

export const SHORTCUTS = {
  palette: { label: "Command palette", group: "Navigation", keys: [{ mod: true, key: "K" }] },
  quickSwitch: {
    label: "Switch project or session",
    group: "Navigation",
    keys: [{ mod: true, key: "P" }],
  },
  switchModel: {
    label: "Switch model",
    group: "Navigation",
    keys: [{ mod: true, shift: true, key: "M" }],
  },
  shortcuts: { label: "Keyboard shortcuts", group: "Navigation", keys: [{ mod: true, key: "/" }] },
  // Home's mode row, while focus isn't in a text field.
  homeCode: { label: "Home: Code", group: "Navigation", keys: [{ key: "1" }] },
  homeGoals: { label: "Home: Goals", group: "Navigation", keys: [{ key: "2" }] },
  homeChat: { label: "Home: Chat", group: "Navigation", keys: [{ key: "3" }] },
  homeMotion: { label: "Home: Motion", group: "Navigation", keys: [{ key: "4" }] },
  homeWorld: { label: "Home: World", group: "Navigation", keys: [{ key: "5" }] },
  newWindow: { label: "New window", group: "Windows", keys: [{ mod: true, key: "N" }] },
  nextWindow: { label: "Next window", group: "Windows", keys: [{ mod: true, key: "`" }] },
  prevWindow: {
    label: "Previous window",
    group: "Windows",
    keys: [{ mod: true, shift: true, key: "`" }],
  },
  arrangeWindows: {
    label: "Arrange all windows",
    group: "Windows",
    keys: [{ mod: true, shift: true, key: "A" }],
  },
  zoomIn: { label: "Zoom in", group: "View", keys: [{ mod: true, key: "=" }] },
  zoomOut: { label: "Zoom out", group: "View", keys: [{ mod: true, key: "-" }] },
  zoomReset: { label: "Reset zoom", group: "View", keys: [{ mod: true, key: "0" }] },
  send: { label: "Send message", group: "Composer", keys: [{ key: "Enter" }] },
  newline: { label: "New line", group: "Composer", keys: [{ shift: true, key: "Enter" }] },
  slash: { label: "Slash commands", group: "Composer", keys: [{ key: "/" }] },
  mention: { label: "Mention a file", group: "Composer", keys: [{ key: "@" }] },
  shell: { label: "Run a shell command", group: "Composer", keys: [{ key: "!" }] },
  pickMenu: { label: "Pick from an open menu", group: "Composer", keys: [{ key: "Tab" }] },
  history: {
    label: "Previous / next prompt",
    group: "Composer",
    keys: [{ key: "↑" }, { key: "↓" }],
  },
  cyclePermission: {
    label: "Cycle permission mode",
    group: "Composer",
    keys: [{ shift: true, key: "Tab" }],
  },
  dictation: {
    label: "Start / stop dictation",
    group: "Composer",
    keys: [{ ctrl: true, shift: true, key: "Space" }],
  },
  stop: { label: "Stop the run, or close a menu", group: "Composer", keys: [{ key: "Esc" }] },
  rewind: {
    label: "Rewind (empty box)",
    group: "Composer",
    keys: [{ key: "Esc" }, { key: "Esc" }],
  },
  skipUltracode: {
    label: "Send without Ultracode",
    group: "Composer",
    keys: [{ alt: true, key: "W" }],
  },
  closeDialog: { label: "Close a dialog or panel", group: "Dialogs", keys: [{ key: "Esc" }] },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Key caps for one combo, platform-correct ("⌘", "K" or "Ctrl", "K"). */
export function comboParts(combo: KeyCombo, mac: boolean): string[] {
  const parts: string[] = [];
  if (mac) {
    if (combo.ctrl) parts.push("⌃");
    if (combo.alt) parts.push("⌥");
    if (combo.shift) parts.push("⇧");
    if (combo.mod) parts.push("⌘");
  } else {
    if (combo.mod || combo.ctrl) parts.push("Ctrl");
    if (combo.alt) parts.push("Alt");
    if (combo.shift) parts.push("Shift");
  }
  parts.push(combo.key);
  return parts;
}

/** The whole shortcut as text: "⌘K", "Ctrl+Shift+M", "Esc Esc". */
export function formatShortcut(id: ShortcutId, mac: boolean): string {
  return SHORTCUTS[id].keys.map((combo) => comboParts(combo, mac).join(mac ? "" : "+")).join(" ");
}

/** Does this key event press the (single-combo) shortcut? */
export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const combo: KeyCombo | undefined = SHORTCUTS[id].keys[0];
  if (!combo) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (Boolean(combo.mod) !== mod || Boolean(combo.alt) !== event.altKey) return false;
  if (Boolean(combo.shift) !== event.shiftKey) return false;
  const key = combo.key.toLowerCase();
  if (key === "/") return event.code === "Slash" || event.key === "/";
  if (/^[a-z]$/.test(key))
    return event.code === `Key${combo.key}` || event.key.toLowerCase() === key;
  return event.key.toLowerCase() === key;
}

export interface Command {
  id: string;
  title: string;
  section: CommandSection;
  /** Extra words that find it (not highlighted). */
  keywords?: string;
  /** Muted text after the title (a path, a date). */
  detail?: string;
  shortcut?: ShortcutId;
  run: () => void;
}

/**
 * What the current screen can do. A handler that's absent means the action
 * doesn't work here, so its command isn't offered.
 */
export interface CommandHandlers {
  openShortcuts: () => void;
  toggleTheme: () => void;
  openWhatsNew: () => void;
  openSettings: (tab: SettingsTabId) => void;
  newWindow: () => void;
  nextWindow: () => void;
  prevWindow: () => void;
  arrangeWindows: () => void;
  goHome?: () => void;
  openProjects?: () => void;
  newSession?: () => void;
  backToSessions?: () => void;
  openChecklist?: () => void;
  openNotes?: () => void;
  openMemories?: () => void;
  openTasks?: () => void;
  exportTranscript?: () => void;
  toggleTools?: () => void;
  cyclePermission?: () => void;
  togglePlan?: () => void;
  planOn?: boolean;
  toggleAutopilot?: () => void;
  autopilotOn?: boolean;
  toggleUltracode?: () => void;
  ultracodeOn?: boolean;
  toggleOrchestrate?: () => void;
  orchestrateOn?: boolean;
  thinkingLevels?: readonly string[];
  thinkingLevel?: string | null;
  setThinking?: (level: string) => void;
}

const onOff = (on: boolean | undefined): string => (on ? "off" : "on");

/** Every command this screen offers, in display order within each section. */
export function buildCommands(h: CommandHandlers): Command[] {
  const out: Command[] = [];
  const add = (
    id: string,
    title: string,
    run: (() => void) | undefined,
    extra: Partial<Command> = {},
  ): void => {
    if (run) out.push({ id, title, section: "This session", run, ...extra });
  };
  const S = "This session" as const;
  const N = "Navigation" as const;
  add("new-session", "New session", h.newSession, { section: S, keywords: "fresh clear restart" });
  add("toggle-plan", `Turn plan mode ${onOff(h.planOn)}`, h.togglePlan, {
    section: S,
    keywords: "read only",
  });
  add("cycle-permission", "Cycle permission mode", h.cyclePermission, {
    section: S,
    shortcut: "cyclePermission",
    keywords: "ask accept edits bypass",
  });
  add("toggle-autopilot", `Turn Autopilot ${onOff(h.autopilotOn)}`, h.toggleAutopilot, {
    section: S,
    keywords: "israel mentor review",
  });
  add("toggle-ultracode", `Turn Ultracode ${onOff(h.ultracodeOn)}`, h.toggleUltracode, {
    section: S,
  });
  add("toggle-orchestrate", `Turn Orchestrate ${onOff(h.orchestrateOn)}`, h.toggleOrchestrate, {
    section: S,
    keywords: "workers parallel",
  });
  add("open-checklist", "Open checklist", h.openChecklist, { section: S, keywords: "todo" });
  add("open-notes", "Open notes", h.openNotes, { section: S });
  add("open-memories", "Open memories", h.openMemories, { section: S, keywords: "brain" });
  add("open-tasks", "Open tasks", h.openTasks, { section: S });
  add("export-transcript", "Export chat", h.exportTranscript, {
    section: S,
    keywords: "save markdown transcript",
  });
  add("open-project", "Open project…", h.openProjects, { section: N, keywords: "switch folder" });
  add("back-to-sessions", "Open recent sessions…", h.backToSessions, {
    section: N,
    keywords: "history resume",
  });
  add("go-home", "Go home", h.goHome, { section: N });
  add("new-window", "New window", h.newWindow, { section: "Windows", shortcut: "newWindow" });
  add("next-window", "Switch to next window", h.nextWindow, {
    section: "Windows",
    shortcut: "nextWindow",
  });
  add("prev-window", "Switch to previous window", h.prevWindow, {
    section: "Windows",
    shortcut: "prevWindow",
  });
  add("arrange-windows", "Arrange all windows", h.arrangeWindows, {
    section: "Windows",
    shortcut: "arrangeWindows",
    keywords: "grid tile",
  });
  add("toggle-tools", "Show or hide tool activity", h.toggleTools, {
    section: "View",
    keywords: "feed",
  });
  add("toggle-theme", "Toggle light / dark theme", h.toggleTheme, {
    section: "View",
    keywords: "appearance color scheme",
  });
  add("shortcuts", "Show keyboard shortcuts", h.openShortcuts, {
    section: "Help",
    shortcut: "shortcuts",
  });
  add("whats-new", "Show what's new", h.openWhatsNew, {
    section: "Help",
    keywords: "changelog release",
  });
  add("about", "Open About Israel Code", () => h.openSettings("about"), {
    section: "Help",
    keywords: "version",
  });
  if (h.setThinking) {
    const set = h.setThinking;
    for (const level of h.thinkingLevels ?? []) {
      add(`thinking-${level}`, `Set thinking to ${level}`, () => set(level), {
        section: "Models",
        keywords: "reasoning effort",
        detail: level === h.thinkingLevel ? "current" : undefined,
      });
    }
  }
  for (const page of SETTINGS_PAGES) {
    add(`settings-${page.id}`, `Settings: ${page.label}`, () => h.openSettings(page.id), {
      section: "Settings",
      keywords: "preferences",
    });
  }
  return out;
}
