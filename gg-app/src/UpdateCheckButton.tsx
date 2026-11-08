import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowsClockwiseIcon } from "./phosphor-icons";
import { theme } from "./theme";
import { fl } from "./flavor";
import { useAppUpdate, type UpdateCheckResult } from "./update";

/**
 * Settings → Updates: the installed version, a "Check for updates" button
 * that asks GitHub right now instead of waiting for the hourly check, and
 * what it found. When there is an update, the button becomes "Install".
 */
export function UpdateCheckButton(): React.ReactElement {
  const appUpdate = useAppUpdate();
  const { phase, version, progress, install, checkNow } = appUpdate;
  const [current, setCurrent] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setCurrent(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const run = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await checkNow());
    } finally {
      setBusy(false);
    }
  };

  const available = phase === "available" || phase === "installing";
  const installing = phase === "installing";
  const pct = Math.max(0, Math.min(100, Math.round(progress ?? 0)));

  const status = installing
    ? pct >= 100
      ? "Installed. Restarting…"
      : `Installing, ${pct}%`
    : available
      ? fl(`Update to ${version} available.`, `Update to ${version} available. Nu, install it.`)
      : phase === "error"
        ? "The install failed. Try again, or download it from GitHub."
        : busy
          ? fl("Checking…", "Checking with GitHub, hold on…")
          : result === "up-to-date"
            ? fl("You're up to date.", "You're up to date. Sababa.")
            : result === "error"
              ? "Couldn't reach GitHub. Check your connection and try again."
              : "Checks for a new version hourly on its own.";

  return (
    <div className="modal-row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        className="modal-btn"
        type="button"
        disabled={busy || installing}
        onClick={() => void (available ? install() : run())}
      >
        <ArrowsClockwiseIcon size={16} aria-hidden="true" />
        {available ? (installing ? "Installing…" : "Install update") : "Check for updates"}
      </button>
      <span role="status" aria-live="polite" style={{ color: theme.textMuted, fontSize: 12 }}>
        {current && <span>{`v${current} · `}</span>}
        {status}
      </span>
    </div>
  );
}
