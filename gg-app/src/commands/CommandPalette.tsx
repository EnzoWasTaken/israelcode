import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { Modal } from "../Modal";
import { comboParts, SHORTCUTS, type Command, type CommandSection } from "./command-registry";
import type { CommandLoader } from "./dynamic-commands";
import { MenuKeyHints } from "../MenuKeyHints";
import { filterCommands, type CommandMatch } from "./fuzzy";

/** Title text with the matched characters wrapped in <mark>. */
function Highlighted({ text, indices }: { text: string; indices: number[] }): ReactElement {
  if (!indices.length) return <>{text}</>;
  const hit = new Set(indices);
  const parts: ReactElement[] = [];
  let i = 0;
  while (i < text.length) {
    const on = hit.has(i);
    let j = i;
    while (j < text.length && hit.has(j) === on) j++;
    const chunk = text.slice(i, j);
    parts.push(on ? <mark key={i}>{chunk}</mark> : <span key={i}>{chunk}</span>);
    i = j;
  }
  return <>{parts}</>;
}

export function KeyCaps({ parts }: { parts: string[] }): ReactElement {
  return (
    <span className="cmdk-keys">
      {parts.map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}

/**
 * Searchable list of everything this screen can do: a combobox (the input)
 * driving a listbox through aria-activedescendant. Built on Modal, so it
 * shares the dialog entrance/exit, reduced motion, and focus return.
 */
export function CommandPalette({
  commands,
  loaders = [],
  sections,
  mac,
  onClose,
}: {
  commands: readonly Command[];
  loaders?: readonly CommandLoader[];
  sections?: readonly CommandSection[];
  mac: boolean;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Command[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // Projects, sessions and models arrive as they load; a failure just leaves
  // that section out. Results after close are dropped.
  useEffect(() => {
    let live = true;
    for (const load of loaders) {
      load()
        .then((more) => {
          if (live) setLoaded((prev) => [...prev, ...more]);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // Loaders are read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matches = useMemo(
    () => filterCommands([...commands, ...loaded], query, sections),
    [commands, loaded, query, sections],
  );
  const current = Math.min(active, Math.max(matches.length - 1, 0));
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const run = (match: CommandMatch | undefined): void => {
    if (!match) return;
    onClose();
    match.command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const last = matches.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = current >= last ? 0 : current + 1;
    else if (event.key === "ArrowUp") next = current <= 0 ? last : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter") {
      event.preventDefault();
      run(matches[current]);
      return;
    }
    if (next === null || last < 0) return;
    event.preventDefault();
    setActive(next);
  };

  // Rows grouped under their section heading, keeping one flat index.
  const groups: Array<{ section: CommandSection; rows: Array<CommandMatch & { index: number }> }> =
    [];
  matches.forEach((match, index) => {
    const group = groups[groups.length - 1];
    if (group?.section === match.command.section) group.rows.push({ ...match, index });
    else groups.push({ section: match.command.section, rows: [{ ...match, index }] });
  });

  return (
    <Modal title="Command palette" onClose={onClose} className="command-palette">
      <input
        className="cmdk-input"
        type="text"
        role="combobox"
        aria-label="Search commands"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={matches.length ? optionId(current) : undefined}
        placeholder={
          sections?.includes("Models")
            ? "Switch model…"
            : sections
              ? "Switch project or session…"
              : "Type a command, project, session or model…"
        }
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        data-modal-initial-focus
      />
      <div ref={listRef} id={listId} role="listbox" aria-label="Commands" className="cmdk-list">
        {groups.map((group) => (
          <div key={group.section} role="group" aria-label={group.section}>
            <div className="cmdk-section" aria-hidden="true">
              {group.section}
            </div>
            {group.rows.map(({ command, indices, index }) => (
              <div
                key={command.id}
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={index === current}
                className="cmdk-row"
                onMouseMove={() => {
                  if (index !== current) setActive(index);
                }}
                // Keep focus in the input; the click runs the row.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run({ command, indices })}
              >
                <span className="cmdk-title">
                  <Highlighted text={command.title} indices={indices} />
                </span>
                {command.detail && <span className="cmdk-detail">{command.detail}</span>}
                {command.shortcut && (
                  <KeyCaps
                    parts={SHORTCUTS[command.shortcut].keys.flatMap((combo) =>
                      comboParts(combo, mac),
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {matches.length === 0 && (
        <p className="cmdk-empty" role="status">
          No matching command
        </p>
      )}
      <MenuKeyHints />
    </Modal>
  );
}
