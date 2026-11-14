import { useEffect, useRef } from "react";
import { FileTextIcon } from "./phosphor-icons";
import { theme } from "./theme";
import type { FileHit } from "./agent";
import { useScrollEdges } from "./popover";
import { MenuKeyHints, type MenuKeyHint } from "./MenuKeyHints";
import { MENTION_MENU_ID, menuOptionId } from "./composer-commands";

const HINTS: readonly MenuKeyHint[] = [
  { keys: "↑↓", does: "move" },
  { keys: "Enter", does: "pick" },
  { keys: "Tab", does: "pick" },
  { keys: "Esc", does: "close" },
];

interface Props {
  files: readonly FileHit[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  /** Whether the current query is empty (drives the header label). */
  isRecent: boolean;
  onSelect: (file: FileHit) => void;
  onHover: (index: number) => void;
}

/**
 * Upward file picker anchored to the chat input, opened by typing `@`. Mirrors
 * SlashMenu: bright basename + dimmed directory path, file icon. Keyboard nav
 * (↑/↓/Tab/Enter/Esc) lives in the input's onKeyDown; this is presentational.
 */
export function FileMentionMenu({
  files,
  activeIndex,
  isRecent,
  onSelect,
  onHover,
}: Props): React.ReactElement {
  // Keep the active row scrolled into view as the selection moves. Skip the
  // first run (mount) so opening the menu never scrolls the page/transcript.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scrollRef.current
      ?.querySelector(`.mention-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        {isRecent ? "Recent files" : "Files"}
      </div>
      <div
        ref={scrollRef}
        id={MENTION_MENU_ID}
        role="listbox"
        aria-label={isRecent ? "Recent files" : "Files"}
        className="pop-scroll slash-scroll"
        onScroll={onScroll}
      >
        {files.map((file, i) => {
          const active = i === activeIndex;
          const dir = file.path.slice(0, file.path.length - file.name.length);
          return (
            <button
              key={file.path}
              id={menuOptionId(MENTION_MENU_ID, i)}
              role="option"
              aria-selected={active}
              tabIndex={-1}
              data-idx={i}
              className={`slash-item mention-item${active ? " active" : ""}`}
              onMouseMove={() => {
                if (!active) onHover(i);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(file)}
            >
              <span className="mention-icon" style={{ color: theme.textMuted }}>
                <FileTextIcon size={14} />
              </span>
              <span className="mention-name" style={{ color: theme.text }}>
                {file.name}
              </span>
              {dir && (
                <span className="mention-dir" style={{ color: theme.textMuted }}>
                  {dir}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <MenuKeyHints hints={HINTS} />
    </div>
  );
}
