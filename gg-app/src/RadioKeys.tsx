import { useRef } from "react";

export interface RadioKeyItem {
  value: string;
  label: string;
  checked: boolean;
}

/**
 * WAI-ARIA radio group made of `.key` buttons: roving tabindex, Arrow keys
 * move and select, Home/End jump to the first/last.
 */
export function RadioKeys({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: readonly RadioKeyItem[];
  onSelect: (value: string) => void;
}): React.ReactElement {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabStop = Math.max(
    0,
    items.findIndex((i) => i.checked),
  );

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const last = items.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    refs.current[next]?.focus();
    onSelect(items[next].value);
  }

  return (
    <div className="key-group" role="radiogroup" aria-label={label}>
      {items.map((item, i) => (
        <button
          key={item.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          className="key key-sm"
          role="radio"
          aria-checked={item.checked}
          tabIndex={i === tabStop ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => onSelect(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
