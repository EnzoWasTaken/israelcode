import { Fragment, useEffect, useRef } from "react";
import { theme } from "./theme";
import { useScrollEdges } from "./popover";
import { MenuKeyHints, type MenuKeyHint } from "./MenuKeyHints";
import { SLASH_MENU_ID, menuOptionId, type ComposerCommand } from "./composer-commands";

interface Props {
  commands: readonly ComposerCommand[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  onSelect: (command: ComposerCommand) => void;
  onHover: (index: number) => void;
  /** The typed `/word` when nothing matches; shows a muted row instead of rows. */
  noMatch?: string;
}

const HINTS: readonly MenuKeyHint[] = [
  { keys: "↑↓", does: "move" },
  { keys: "Enter", does: "pick" },
  { keys: "Tab", does: "pick" },
  { keys: "Esc", does: "clear" },
];
const NO_MATCH_HINTS: readonly MenuKeyHint[] = [{ keys: "Enter", does: "send anyway" }];

const GROUP_TITLE = {
  "built-in": "Built-in",
  custom: "Project commands",
  skill: "Skills",
} as const;

/** Upward list of the slash commands matching the current `/prefix`. Keys live in the input's onKeyDown. */
export function SlashMenu({
  commands,
  activeIndex,
  onSelect,
  onHover,
  noMatch,
}: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  const mounted = useRef(false);
  // Keep the active row scrolled into view; skip mount so opening never scrolls the page.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scrollRef.current
      ?.querySelector(`.slash-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        Commands
      </div>
      <div
        ref={scrollRef}
        id={SLASH_MENU_ID}
        role="listbox"
        aria-label="Commands"
        className="pop-scroll slash-scroll"
        onScroll={onScroll}
      >
        {noMatch !== undefined && commands.length === 0 && (
          <div className="slash-empty" style={{ color: theme.textMuted }}>
            No command matches {noMatch}
          </div>
        )}
        {commands.map((cmd, i) => {
          const active = i === activeIndex;
          const group = cmd.source ?? "built-in";
          const showHeading = i === 0 || (commands[i - 1]?.source ?? "built-in") !== group;
          return (
            <Fragment key={cmd.name}>
              {showHeading && (
                <div className="slash-group" role="presentation" style={{ color: theme.textDim }}>
                  {GROUP_TITLE[group]}
                </div>
              )}
              <button
                id={menuOptionId(SLASH_MENU_ID, i)}
                role="option"
                aria-selected={active}
                tabIndex={-1}
                data-idx={i}
                className={`slash-item${active ? " active" : ""}`}
                onMouseMove={() => {
                  if (!active) onHover(i);
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(cmd)}
              >
                <span className="slash-name" style={{ color: theme.commandColor }}>
                  /{cmd.name}
                </span>
                {cmd.usage && (
                  <span className="slash-usage" style={{ color: theme.textDim }}>
                    {cmd.usage}
                  </span>
                )}
                <span className="slash-desc" style={{ color: theme.textMuted }}>
                  {cmd.description}
                </span>
              </button>
            </Fragment>
          );
        })}
      </div>
      <MenuKeyHints
        hints={noMatch !== undefined && commands.length === 0 ? NO_MATCH_HINTS : HINTS}
      />
    </div>
  );
}
