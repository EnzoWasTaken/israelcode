import type { SlashCommand } from "./agent";

// `/schedule` lives in the webview, not the sidecar's command registry: it
// registers a recurring timer instead of prompting the agent. Declared here so
// the palette can still discover it alongside the real slash commands.
// Handled in the webview too: it flips the session's Ultracode setting.
export const ULTRACODE_COMMAND: SlashCommand = {
  name: "ultracode",
  aliases: [],
  description: "Turn Ultracode on or off — parallel agents for big jobs — [on|off]",
  source: "built-in",
};

export const SCHEDULE_COMMAND: SlashCommand = {
  name: "schedule",
  aliases: ["sched"],
  description: "Run a prompt on a repeating schedule — <prompt> | 15m | [times]",
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
