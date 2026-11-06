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

/** The draft split around each "ultracode" keyword, for the composer highlight. */
export function splitUltracode(text: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  const re = /(^|[^\w-])(ultracode)(?=$|[^\w-])/gi;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0);
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: m[2] ?? "", hit: true });
    at = start + (m[2]?.length ?? 0);
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
