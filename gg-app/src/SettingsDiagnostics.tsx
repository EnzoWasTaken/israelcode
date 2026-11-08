import { useCallback, useEffect, useState } from "react";
import { SettingsCard } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";
import { errorText } from "./settings-kit";
import { getRoutingDiagnostics, type RouteDiagnostic } from "./agent";
import "./SettingsPages.css";

const LOG_PATH = "~/.israelcode/gg-app-sidecar.log";

function timeOf(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Settings → Diagnostics: recent Auto decisions (content-free by design) and the log location. */
export function SettingsDiagnostics(): React.ReactElement {
  const [rows, setRows] = useState<RouteDiagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useSettingsPageReady(loaded);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setRows(await getRoutingDiagnostics());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = rows ? [...rows].sort((a, b) => b.timestamp - a.timestamp) : null;

  return (
    <>
      <SettingsCard
        title="Auto routing decisions"
        description="The latest choices Auto made. Your prompts are never recorded here, only what was chosen and why."
      >
        <div className="sp-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error && (
          <p className="sp-error" role="alert">
            Couldn&rsquo;t load diagnostics: {error}
          </p>
        )}
        {sorted && sorted.length === 0 && !error && (
          <p className="sp-help">No decisions yet. They appear once Auto routes a prompt.</p>
        )}
        {sorted && sorted.length > 0 && (
          <div className="sp-table-wrap">
            <table className="sp-table">
              <caption className="sr-only">Recent Auto routing decisions</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Model</th>
                  <th scope="col">Effort</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Source</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Latency</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={`${d.timestamp}-${d.sessionHash}-${d.textHash}`}>
                    <td>{timeOf(d.timestamp)}</td>
                    <td className="sp-code">{d.model}</td>
                    <td>{d.effort ?? "—"}</td>
                    <td>{d.executionMode}</td>
                    <td>{d.source}</td>
                    <td className="is-wrap">
                      {d.reason}
                      {d.fallbackReason ? ` (${d.fallbackReason})` : ""}
                    </td>
                    <td>{Math.round(d.confidence * 100)}%</td>
                    <td>{d.latencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>
      <SettingsCard
        title="App log"
        description="If something goes wrong, this file says what happened."
      >
        <p className="sp-help">
          The background service writes to <span className="sp-code">{LOG_PATH}</span> in your home
          folder. It never contains your keys.
        </p>
      </SettingsCard>
    </>
  );
}
