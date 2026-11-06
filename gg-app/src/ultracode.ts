// Ultracode in the composer: the per-prompt keyword and the `/ultracode` command.

/** A typed prompt asking for Ultracode for just that prompt (as the sidecar checks). */
export function hasUltracodeKeyword(text: string): boolean {
  return /(^|[^\w-])ultracode($|[^\w-])/i.test(text);
}

/**
 * `/ultracode`, `/ultracode on` or `/ultracode off`: the setting to apply
 * (`"toggle"` with no argument), or null when the draft is something else.
 */
export function parseUltracodeCommand(text: string): "on" | "off" | "toggle" | null {
  const m = /^\/ultracode(?:\s+(on|off))?\s*$/i.exec(text.trim());
  if (!m) return null;
  return m[1] ? (m[1].toLowerCase() as "on" | "off") : "toggle";
}
