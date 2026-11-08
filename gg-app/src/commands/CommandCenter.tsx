import { useEffect, useMemo, useState, type ReactElement } from "react";
import { isMacPlatform } from "../platform";
import {
  buildCommands,
  formatShortcut,
  matchesShortcut,
  type CommandHandlers,
} from "./command-registry";
import {
  closeCommandSurface,
  openPalette,
  openShortcuts,
  useCommandSurface,
} from "./command-store";
import { CommandPalette } from "./CommandPalette";
import type { CommandLoader } from "./dynamic-commands";
import { ShortcutsSheet } from "./ShortcutsSheet";

/** Another dialog is up: don't open a palette over it. */
function otherDialogOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (el) => !el.classList.contains("command-palette") && !el.classList.contains("shortcuts-sheet"),
  );
}

/**
 * The window's keyboard layer: ⌘/Ctrl+K palette, ⌘/Ctrl+P projects and
 * sessions, ⌘/Ctrl+Shift+M models, ⌘/Ctrl+/ shortcuts sheet. Rendered once
 * per screen with what that screen can do.
 */
export function CommandCenter({
  handlers,
  loaders,
  modelLoaders,
  switchLoaders,
}: {
  handlers: Omit<CommandHandlers, "openShortcuts">;
  /** Everything dynamic the full palette lists. */
  loaders: readonly CommandLoader[];
  modelLoaders: readonly CommandLoader[];
  switchLoaders: readonly CommandLoader[];
}): ReactElement | null {
  const surface = useCommandSurface();
  const mac = isMacPlatform();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      let open: (() => void) | null = null;
      if (matchesShortcut(event, "palette")) open = () => openPalette();
      else if (matchesShortcut(event, "quickSwitch"))
        open = () => openPalette(["Projects", "Sessions"]);
      else if (matchesShortcut(event, "switchModel")) open = () => openPalette(["Models"]);
      else if (matchesShortcut(event, "shortcuts")) open = openShortcuts;
      if (!open) return;
      event.preventDefault();
      if (otherDialogOpen()) return;
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving this screen closes what it opened.
  useEffect(() => closeCommandSurface, []);

  const commands = useMemo(
    () => buildCommands({ ...handlers, openShortcuts }),
    // Rebuilt per opening; handlers change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface],
  );

  if (surface?.kind === "shortcuts") {
    return <ShortcutsSheet mac={mac} onClose={closeCommandSurface} />;
  }
  if (surface?.kind === "palette") {
    const models = surface.sections?.includes("Models");
    const narrowed = surface.sections !== undefined;
    return (
      <CommandPalette
        // A different shortcut while open starts a fresh list.
        key={surface.sections?.join() ?? "all"}
        commands={commands}
        loaders={models ? modelLoaders : narrowed ? switchLoaders : loaders}
        sections={surface.sections}
        mac={mac}
        onClose={closeCommandSurface}
      />
    );
  }
  return null;
}

const HINT_KEY = "gg-shortcut-hint-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * In flow under the workspace (it never covers content): once, a dismissible
 * note about the palette and the shortcuts sheet; after that, a quiet reminder.
 */
export function ShortcutHint(): ReactElement {
  const [dismissed, setDismissed] = useState(readDismissed);
  const mac = isMacPlatform();
  const palette = formatShortcut("palette", mac);
  const sheet = formatShortcut("shortcuts", mac);
  if (dismissed) {
    return (
      <div className="shortcut-hint is-quiet">
        <button type="button" className="shortcut-hint-link" onClick={() => openPalette()}>
          <kbd>{palette}</kbd> commands
        </button>
        <button type="button" className="shortcut-hint-link" onClick={openShortcuts}>
          <kbd>{sheet}</kbd> shortcuts
        </button>
      </div>
    );
  }
  return (
    <div className="shortcut-hint" role="note">
      <span>
        Press <kbd>{palette}</kbd> for every command, and <kbd>{sheet}</kbd> for keyboard shortcuts.
      </span>
      <button
        type="button"
        className="shortcut-hint-dismiss"
        onClick={() => {
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {
            // Storage unavailable: hide it for this window anyway.
          }
          setDismissed(true);
        }}
      >
        Got it
      </button>
    </div>
  );
}
