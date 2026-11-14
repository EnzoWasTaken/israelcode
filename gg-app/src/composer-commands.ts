import type { SlashCommand } from "./agent";

// `/schedule` lives in the webview, not the sidecar's command registry: it
// registers a recurring timer instead of prompting the agent. Declared here so
// the palette can still discover it alongside the real slash commands.
// Handled in the webview too: it flips the session's Ultracode setting.
export type ComposerCommand = SlashCommand & { usage?: string };

export const SLASH_MENU_ID = "composer-slash-menu";
export const MENTION_MENU_ID = "composer-mention-menu";
export const SHELL_MENU_ID = "composer-shell-menu";

export function menuOptionId(menuId: string, index: number): string {
  return `${menuId}-opt-${index}`;
}

export const ULTRACODE_COMMAND: ComposerCommand = {
  name: "ultracode",
  aliases: [],
  description: "Turn Ultracode on or off, so big jobs run with parallel agents",
  usage: "[on|off]",
  source: "built-in",
};

export const SCHEDULE_COMMAND: ComposerCommand = {
  name: "schedule",
  aliases: ["sched"],
  description: "Run a prompt again and again on a timer",
  usage: "<prompt> | 15m | [times]",
  source: "built-in",
};

/** True when the text is a known workflow command invocation (first token). */
export function isWorkflowCommand(text: string, commands: readonly SlashCommand[]): boolean {
  if (!text.startsWith("/")) return false;
  const name = text.slice(1).split(" ")[0]?.toLowerCase() ?? "";
  return commands.some(
    (c) => c.name.toLowerCase() === name || c.aliases.some((a) => a.toLowerCase() === name),
  );
}
