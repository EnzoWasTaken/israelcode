import type { SettingsTabId } from "../settings-sections";

/**
 * Settings pages, in nav order. A plain copy so the palette doesn't load the
 * Settings screen's code; command-registry.test.ts fails if it drifts from
 * SETTINGS_SECTIONS.
 */
export const SETTINGS_PAGES: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "providers", label: "AI Providers" },
  { id: "auto-routing", label: "Auto routing" },
  { id: "execution-modes", label: "Execution modes" },
  { id: "cost", label: "Cost & usage" },
  { id: "sessions", label: "Sessions & background" },
  { id: "remote", label: "Remote" },
  { id: "mcp", label: "MCP" },
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

export type CommandSection = "Actions" | "Projects" | "Sessions" | "Models" | "Settings";
export const SECTION_ORDER: readonly CommandSection[] = [
  "Actions",
  "Projects",
  "Sessions",
  "Models",
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

export type ShortcutGroup = "General" | "Windows" | "View" | "Composer" | "Dialogs";
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "General",
  "Windows",
  "View",
  "Composer",
  "Dialogs",
];

export interface ShortcutDef {
  label: string;
  group: ShortcutGroup;
  /** Pressed in order (Escape twice is two combos). */
  keys: readonly KeyCombo[];
}

export const SHORTCUTS = {
  palette: { label: "Command palette", group: "General", keys: [{ mod: true, key: "K" }] },
  quickSwitch: {
    label: "Switch project or session",
    group: "General",
    keys: [{ mod: true, key: "P" }],
  },
  switchModel: {
    label: "Switch model",
    group: "General",
    keys: [{ mod: true, shift: true, key: "M" }],
  },
  shortcuts: { label: "Keyboard shortcuts", group: "General", keys: [{ mod: true, key: "/" }] },
  // Home's mode row, while focus isn't in a text field.
  homeCode: { label: "Home: Code", group: "General", keys: [{ key: "1" }] },
  homeGoals: { label: "Home: Goals", group: "General", keys: [{ key: "2" }] },
  homeChat: { label: "Home: Chat", group: "General", keys: [{ key: "3" }] },
  homeMotion: { label: "Home: Motion", group: "General", keys: [{ key: "4" }] },
  homeWorld: { label: "Home: World", group: "General", keys: [{ key: "5" }] },
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
    if (run) out.push({ id, title, section: "Actions", run, ...extra });
  };
  add("new-session", "New session", h.newSession, { keywords: "fresh clear restart" });
  add("open-project", "Open project…", h.openProjects, { keywords: "switch folder" });
  add("back-to-sessions", "Recent sessions…", h.backToSessions, { keywords: "history resume" });
  add("go-home", "Go home", h.goHome);
  add("toggle-plan", `Turn plan mode ${onOff(h.planOn)}`, h.togglePlan, { keywords: "read only" });
  add("cycle-permission", "Cycle permission mode", h.cyclePermission, {
    shortcut: "cyclePermission",
    keywords: "ask accept edits bypass",
  });
  add("toggle-autopilot", `Turn Autopilot ${onOff(h.autopilotOn)}`, h.toggleAutopilot, {
    keywords: "israel mentor review",
  });
  add("toggle-ultracode", `Turn Ultracode ${onOff(h.ultracodeOn)}`, h.toggleUltracode);
  add("toggle-orchestrate", `Turn Orchestrate ${onOff(h.orchestrateOn)}`, h.toggleOrchestrate, {
    keywords: "workers parallel",
  });
  add("open-checklist", "Open checklist", h.openChecklist, { keywords: "todo" });
  add("open-notes", "Open notes", h.openNotes);
  add("open-memories", "Open memories", h.openMemories, { keywords: "brain" });
  add("open-tasks", "Open tasks", h.openTasks);
  add("toggle-tools", "Show or hide tool activity", h.toggleTools, { keywords: "feed" });
  add("export-transcript", "Export transcript", h.exportTranscript, { keywords: "save markdown" });
  add("toggle-theme", "Toggle light / dark theme", h.toggleTheme, {
    keywords: "appearance color scheme",
  });
  add("shortcuts", "Keyboard shortcuts", h.openShortcuts, { shortcut: "shortcuts" });
  add("whats-new", "What's New", h.openWhatsNew, { keywords: "changelog release" });
  add("about", "About Israel Code", () => h.openSettings("about"), { keywords: "version" });
  add("new-window", "New window", h.newWindow, { shortcut: "newWindow" });
  add("next-window", "Next window", h.nextWindow, { shortcut: "nextWindow" });
  add("prev-window", "Previous window", h.prevWindow, { shortcut: "prevWindow" });
  add("arrange-windows", "Arrange all windows", h.arrangeWindows, {
    shortcut: "arrangeWindows",
    keywords: "grid tile",
  });
  if (h.setThinking) {
    const set = h.setThinking;
    for (const level of h.thinkingLevels ?? []) {
      add(`thinking-${level}`, `Thinking: ${level}`, () => set(level), {
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
