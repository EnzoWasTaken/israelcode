import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./BootScreen.css";

/**
 * The "Israel" boot screen: a fake BIOS power-on check that plays once each
 * time the app launches, with start-up-nation jokes instead of hardware. It
 * sits on top of the real app (which is already loading underneath), so it
 * never delays anything; any key or click skips it.
 */

export type BootStatus = "ok" | "warn" | "busy";

export interface BootLine {
  text: string;
  status: BootStatus;
  /** The tag shown at the end of the line. */
  tag: string;
}

export const BOOT_LINES: readonly BootLine[] = [
  { text: "Mounting hummus (extra tahini)", status: "ok", tag: "OK" },
  { text: "Loading falafel.dll", status: "ok", tag: "OK" },
  { text: "Waking the sidecar", status: "ok", tag: "OK" },
  { text: "Pivoting to AI", status: "ok", tag: "ALREADY AI" },
  { text: "Pitching the sidecar to investors", status: "busy", tag: "SERIES A" },
  { text: "Asking my cousin who knows computers", status: "busy", tag: "ON THE PHONE" },
  { text: "Tabs vs spaces: everyone has an opinion", status: "warn", tag: "ARGUING" },
  { text: "Wi-Fi (it's fine, it's always fine)", status: "ok", tag: "OK" },
];

export const BOOT_GREETING = "Shalom. Ready to ship.";
const SEEN_KEY = "ic-boot-seen";
const LINE_MS = 240;
const HOLD_MS = 650;
const REDUCED_HOLD_MS = 900;

/** True once this launch has already shown the boot screen. */
export function bootAlreadySeen(storage: Pick<Storage, "getItem"> = sessionStorage): boolean {
  try {
    return storage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markBootSeen(storage: Pick<Storage, "setItem"> = sessionStorage): void {
  try {
    storage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode: it just plays again next window */
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function BootScreen({ onDone }: { onDone: () => void }): React.ReactElement {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [shown, setShown] = useState(reduced ? BOOT_LINES.length : 0);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    markBootSeen();
    setLeaving(true);
  }, []);

  // One line per tick, then a short beat on the greeting, then out.
  useEffect(() => {
    if (leaving) return;
    if (shown < BOOT_LINES.length) {
      const id = window.setTimeout(() => setShown((n) => n + 1), LINE_MS);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(finish, reduced ? REDUCED_HOLD_MS : HOLD_MS);
    return () => window.clearTimeout(id);
  }, [shown, leaving, reduced, finish]);

  useEffect(() => {
    window.addEventListener("keydown", finish);
    return () => window.removeEventListener("keydown", finish);
  }, [finish]);

  // Unmount after the fade; the fade is skipped when motion is reduced.
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(onDone, reduced ? 0 : 320);
    return () => window.clearTimeout(id);
  }, [leaving, reduced, onDone]);

  const complete = shown >= BOOT_LINES.length;
  const progress = Math.round((shown / BOOT_LINES.length) * 100);

  return (
    <div
      className={`boot-screen${leaving ? " boot-screen-leaving" : ""}`}
      role="status"
      aria-label="Israel Code is starting"
      onClick={finish}
    >
      <div className="boot-panel">
        <h1 className="boot-title">ISRAEL CODE</h1>
        <p className="boot-sub">Start-Up Nation BIOS v0.106 · based on GG Coder</p>
        <ul className="boot-log" aria-hidden="true">
          {BOOT_LINES.slice(0, shown).map((line) => (
            <li key={line.text} className="boot-line">
              <span className="boot-line-text">{line.text}</span>
              <span className="boot-line-dots" />
              <span className={`boot-tag boot-tag-${line.status}`}>[ {line.tag} ]</span>
            </li>
          ))}
        </ul>
        <div
          className="boot-pita"
          role="progressbar"
          aria-label="Pita loading"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span className="boot-pita-bar" style={{ width: `${progress}%` }} />
        </div>
        <p className={`boot-greeting${complete ? " boot-greeting-on" : ""}`}>
          {complete ? BOOT_GREETING : "\u00a0"}
        </p>
        <button type="button" className="boot-skip" onClick={finish}>
          Skip (we both know it's fast)
        </button>
      </div>
    </div>
  );
}

/** Wraps the app: shows the boot screen once per launch, on top of it. */
export function BootGate(): React.ReactElement | null {
  const [visible, setVisible] = useState(() => !bootAlreadySeen());
  const onDone = useCallback(() => setVisible(false), []);
  return visible ? <BootScreen onDone={onDone} /> : null;
}
