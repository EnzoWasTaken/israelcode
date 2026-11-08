import type { ReactElement } from "react";
import { Modal } from "../Modal";
import { comboParts, SHORTCUT_GROUPS, SHORTCUTS, type ShortcutDef } from "./command-registry";
import { KeyCaps } from "./CommandPalette";

/** Every shortcut in the registry, grouped, with this platform's key labels. */
export function ShortcutsSheet({
  mac,
  onClose,
}: {
  mac: boolean;
  onClose: () => void;
}): ReactElement {
  const all: ShortcutDef[] = Object.values(SHORTCUTS);
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} className="shortcuts-sheet">
      <div className="shortcuts-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group} className="shortcuts-group" aria-label={group}>
            <h3 className="shortcuts-heading">{group}</h3>
            <dl>
              {all
                .filter((s) => s.group === group)
                .map((s) => (
                  <div key={s.label} className="shortcuts-row">
                    <dt>{s.label}</dt>
                    <dd>
                      <KeyCaps parts={s.keys.flatMap((combo) => comboParts(combo, mac))} />
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
