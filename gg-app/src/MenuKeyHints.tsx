import type { ReactElement } from "react";
import "./MenuKeyHints.css";

export interface MenuKeyHint {
  keys: string; // "↑↓", "Enter", "Tab", "Esc"
  does: string; // "move", "open", "pick", "close"
}

export const MOVE_PICK_CLOSE: readonly MenuKeyHint[] = [
  { keys: "↑↓", does: "move" },
  { keys: "Enter", does: "pick" },
  { keys: "Esc", does: "close" },
];

export function MenuKeyHints({
  hints = MOVE_PICK_CLOSE,
}: {
  hints?: readonly MenuKeyHint[];
}): ReactElement {
  return (
    <div className="menu-key-hints" aria-hidden="true">
      {hints.map((h) => (
        <span key={h.keys} className="menu-key-hint">
          <kbd>{h.keys}</kbd> {h.does}
        </span>
      ))}
    </div>
  );
}
