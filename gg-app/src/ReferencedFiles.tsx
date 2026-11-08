import { useLayoutEffect, useRef } from "react";
import { AtIcon, XIcon } from "./phosphor-icons";
import { theme } from "./theme";
import { pinSize, usePresenceList } from "./usePresenceList";

/** Exit duration of `.mention-bar.leaving` / `.mention-chip.leaving`: equal to `--dur-strip-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_MS = 220;

const keyOf = (p: string): string => p;

/**
 * Inline-code-styled chips for each `@`-referenced file. The paths are tracked
 * in state (not in the textarea text); removing a chip drops it from that state.
 * Chips animate in and out the same way as the attachment chips.
 */
export function ReferencedFiles({
  paths,
  onRemove,
  sendCount = 0,
}: {
  paths: readonly string[];
  onRemove: (path: string) => void;
  /** Composer sends so far. A change drops chips the send cleared without an exit (see usePresenceList). */
  sendCount?: number;
}): React.ReactElement | null {
  const shown = usePresenceList(paths, keyOf, EXIT_MS, sendCount);
  const empty = shown.length === 0;
  const barLeaving = !empty && shown.every((s) => s.leaving);
  const barRef = useRef<HTMLDivElement>(null);
  // Measure on mount (enter grows to this height) and again when the bar starts
  // leaving (exit folds from it).
  useLayoutEffect(() => pinSize(barRef.current), [barLeaving, empty]);

  if (empty) return null;
  return (
    <div ref={barRef} className={`mention-bar${barLeaving ? " leaving" : ""}`}>
      {shown.map(({ item: p, key, leaving }) => (
        <div
          key={key}
          ref={leaving ? pinSize : undefined}
          className={`mention-chip${leaving ? " leaving" : ""}`}
          inert={leaving}
          title={p}
          style={{ background: theme.surface1, borderColor: theme.border }}
        >
          <AtIcon size={11} className="mention-chip-at" style={{ color: theme.accent }} />
          <span className="mention-chip-name" style={{ color: theme.code }}>
            {p}
          </span>
          <button
            className="mention-chip-remove"
            aria-label={`Remove ${p}`}
            onClick={() => onRemove(p)}
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Heading that marks the appended referenced-files block (shared by writer +
 *  parser so history restore can recover the chips). */
const REF_HEADING = "Referenced files:";

/** Append referenced file paths to a prompt as a compact block so the agent
 *  knows which files to read. Returns the prompt unchanged when there are none. */
export function appendReferencedFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const block = `${REF_HEADING}\n${paths.map((p) => `- ${p}`).join("\n")}`;
  return text ? `${text}\n\n${block}` : block;
}

/** Inverse of appendReferencedFiles: split a stored prompt back into its clean
 *  text and the referenced paths, for hydrating a resumed session's bubbles. */
export function parseReferencedFiles(full: string): { text: string; files: string[] } {
  const idx = full.lastIndexOf(`\n\n${REF_HEADING}\n`);
  // Also handle a chips-only prompt (no leading text).
  const headOnly = full.startsWith(`${REF_HEADING}\n`);
  if (idx < 0 && !headOnly) return { text: full, files: [] };
  const blockStart = headOnly ? 0 : idx + 2; // skip the "\n\n"
  const text = headOnly ? "" : full.slice(0, idx);
  const lines = full.slice(blockStart).split("\n").slice(1); // drop the heading
  const files: string[] = [];
  for (const line of lines) {
    const m = /^- (.+)$/.exec(line);
    if (m && m[1]) files.push(m[1]);
    else break; // block is contiguous; stop at the first non-item line
  }
  return files.length > 0 ? { text, files } : { text: full, files: [] };
}
