import { SmileyWinkIcon } from "./phosphor-icons";
import { theme } from "./theme";
import { setFlavorEnabled, useFlavorEnabled } from "./flavor";

/**
 * Settings → Effects switch for Israel Code's jokes (placeholders, status
 * lines, tips, the boot screen), shaped like the sound switch beside it.
 * Off is the same app with plain wording.
 */
export function HumorButton(): React.ReactElement {
  const on = useFlavorEnabled();
  return (
    <button
      className="modal-btn"
      type="button"
      aria-pressed={on}
      title={
        on
          ? "Humour on — click for plain wording everywhere"
          : "Humour off — click to bring the jokes back"
      }
      style={on ? undefined : { color: theme.textMuted }}
      onClick={() => setFlavorEnabled(!on)}
    >
      <SmileyWinkIcon size={16} aria-hidden="true" />
      {on ? "Humour on" : "Humour off"}
    </button>
  );
}
