import { SECTION_ORDER, type Command, type CommandSection } from "./command-registry";

export interface FuzzyMatch {
  score: number;
  /** Indices of `text` that matched, for highlighting. */
  indices: number[];
}

const isBoundary = (text: string, i: number): boolean =>
  i === 0 || /[\s\-_/.:·]/.test(text[i - 1] ?? "");

/**
 * Case-insensitive match: a contiguous substring scores best (more at a word
 * start), then an in-order subsequence that favours runs and word starts.
 * Null when the query's characters aren't all there in order.
 */
export function fuzzyMatch(query: string, text: string, contiguousOnly = false): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => at + i);
    return { score: 1000 + (isBoundary(t, at) ? 200 : 0) - at - t.length / 100, indices };
  }
  if (contiguousOnly) return null;
  const needle = q.replace(/\s+/g, "");
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of needle) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (isBoundary(t, i)) score += 10;
    const prev = indices[indices.length - 1];
    if (prev !== undefined && i === prev + 1) score += 15;
    else score -= Math.min(i - from, 10);
    indices.push(i);
    from = i + 1;
  }
  return { score, indices };
}

export interface CommandMatch {
  command: Command;
  indices: number[];
}

/**
 * The commands that match, best first within each section, sections in
 * order. `sections` narrows the list (the quick switcher: Projects, Sessions).
 * Projects and sessions match their name first; their folder path and other
 * extras only as a contiguous substring, so scattered letters in a long path
 * ("mod" in "/Users/demo/projects/landing-page") never match.
 */
export function filterCommands(
  commands: readonly Command[],
  query: string,
  sections?: readonly CommandSection[],
): CommandMatch[] {
  const typed = query.trim() !== "";
  const scored: Array<CommandMatch & { score: number; order: number }> = [];
  commands.forEach((command, order) => {
    if (sections && !sections.includes(command.section)) return;
    const title = fuzzyMatch(query, command.title);
    if (title) {
      scored.push({ command, indices: title.indices, score: title.score, order });
      return;
    }
    const hay = [command.keywords, command.detail].filter(Boolean).join(" ");
    const strict = command.section === "Projects" || command.section === "Sessions";
    const extra = hay ? fuzzyMatch(query, hay, strict) : null;
    if (extra) scored.push({ command, indices: [], score: extra.score - 500, order });
  });
  scored.sort((a, b) => {
    const bySection =
      SECTION_ORDER.indexOf(a.command.section) - SECTION_ORDER.indexOf(b.command.section);
    if (bySection) return bySection;
    return (typed ? b.score - a.score : 0) || a.order - b.order;
  });
  return scored.map(({ command, indices }) => ({ command, indices }));
}
