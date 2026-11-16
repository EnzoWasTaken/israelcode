import { useId, useState } from "react";
import { theme } from "./theme";
import {
  setLocalEndpointSettings,
  startOllamaServer,
  stopOllamaServer,
  type LocalEndpointRow,
  type LocalModelsState,
  type OllamaServerSettings as Settings,
} from "./agent";

interface Props {
  endpoint: LocalEndpointRow;
  onSaved: (state: LocalModelsState) => void;
}

type IntKey = "contextLength" | "fitTargetMiB" | "cpuMoeLayers";

const INT_FIELDS: { key: IntKey; label: string; hint?: string }[] = [
  { key: "contextLength", label: "Default context length", hint: "OLLAMA_CONTEXT_LENGTH" },
  { key: "fitTargetMiB", label: "Memory fit target (MiB)", hint: "LLAMA_ARG_FIT_TARGET" },
  {
    key: "cpuMoeLayers",
    label: "CPU MoE offload layers",
    hint: "Undocumented: passed through to Ollama's llama-server, may have no effect.",
  },
];

const tri = (v: boolean | undefined): string => (v === undefined ? "auto" : v ? "on" : "off");
const fromTri = (v: string): boolean | undefined => (v === "auto" ? undefined : v === "on");

/** Server-wide Ollama settings; applied by starting Ollama from Israel Code. */
export function OllamaServerSettings({ endpoint, onSaved }: Props): React.ReactElement {
  const uid = useId();
  const saved = endpoint.settings?.ollama ?? {};
  const server = endpoint.server ?? {
    managed: false,
    running: endpoint.reachable,
    canStart: false,
    restartNeeded: false,
  };
  const [flash, setFlash] = useState(tri(saved.flashAttention));
  const [fit, setFit] = useState(tri(saved.fit));
  const [kv, setKv] = useState<string>(saved.kvCacheType ?? "");
  const [auto, setAuto] = useState(saved.autoStart === true);
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      INT_FIELDS.map((f) => [f.key, saved[f.key] === undefined ? "" : String(saved[f.key])]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function build(): Settings | string {
    const out: Settings = {};
    const fa = fromTri(flash);
    if (fa !== undefined) out.flashAttention = fa;
    const f = fromTri(fit);
    if (f !== undefined) out.fit = f;
    if (kv) out.kvCacheType = kv as Settings["kvCacheType"];
    if (auto) out.autoStart = true;
    for (const field of INT_FIELDS) {
      const raw = (text[field.key] ?? "").trim().replace(/[,_\s]/g, "");
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isInteger(n)) return `${field.label} must be a whole number.`;
      out[field.key] = n;
    }
    return out;
  }

  async function run(action: () => Promise<LocalModelsState>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save(andStart: boolean): void {
    const built = build();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    const headers = endpoint.settings?.headers;
    const next = {
      ...(headers ? { headers } : {}),
      ...(Object.keys(built).length > 0 ? { ollama: built } : {}),
    };
    void run(async () => {
      const state = await setLocalEndpointSettings(
        endpoint.id,
        Object.keys(next).length > 0 ? next : null,
      );
      return andStart ? startOllamaServer() : state;
    });
  }

  const inputStyle = { color: theme.text, background: theme.inputBackground, width: "100%" };
  const label = (key: string, text: string): React.ReactElement => (
    <label className="modal-label" htmlFor={`${uid}-${key}`} style={{ color: theme.textMuted }}>
      {text}
    </label>
  );
  const triSelect = (
    text: string,
    key: string,
    value: string,
    set: (v: string) => void,
  ): React.ReactElement => (
    <div>
      {label(key, text)}
      <select
        id={`${uid}-${key}`}
        className="modal-input"
        style={inputStyle}
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        <option value="auto">Auto</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </div>
  );

  return (
    <form
      className="local-model-settings"
      aria-label="Ollama server settings"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
    >
      <div className="modal-hint" style={{ color: theme.textDim }}>
        Server settings are read when Ollama starts, so they apply only to an Ollama that Israel
        Code starts. A server started elsewhere is never changed.
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }} data-testid="ollama-status">
        {server.managed
          ? server.restartNeeded
            ? "Ollama is running from Israel Code. Restart to apply the saved settings."
            : "Ollama is running from Israel Code."
          : server.running
            ? "Ollama was started outside Israel Code, so these settings are not applied. Quit Ollama from the tray, then start it here."
            : server.canStart
              ? "Ollama is not running."
              : "Ollama is not installed."}
      </div>
      <div className="local-model-settings-grid">
        {triSelect("Flash attention", "flash", flash, setFlash)}
        <div>
          {label("kv", "KV cache quantization")}
          <select
            id={`${uid}-kv`}
            className="modal-input"
            style={inputStyle}
            value={kv}
            onChange={(e) => setKv(e.target.value)}
          >
            <option value="">Default</option>
            <option value="f16">f16</option>
            <option value="q8_0">q8_0</option>
            <option value="q4_0">q4_0</option>
          </select>
          <div className="modal-hint" style={{ color: theme.textDim }}>
            Needs flash attention
          </div>
        </div>
        {triSelect("Automatic memory fitting", "fit", fit, setFit)}
        {INT_FIELDS.map((f) => (
          <div key={f.key}>
            {label(f.key, f.label)}
            <input
              id={`${uid}-${f.key}`}
              className="modal-input"
              style={inputStyle}
              inputMode="numeric"
              placeholder="Server default"
              value={text[f.key] ?? ""}
              onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
            />
            {f.hint && (
              <div className="modal-hint" style={{ color: theme.textDim }}>
                {f.hint}
              </div>
            )}
          </div>
        ))}
      </div>
      <label className="local-model-settings-check" style={{ color: theme.textMuted }}>
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Start
        Ollama with these settings when it is not running
      </label>
      {error && (
        <div className="login-status" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="local-model-settings-actions">
        <button type="submit" className="modal-btn" disabled={busy}>
          Save
        </button>
        {server.managed && (
          <>
            <button
              type="button"
              className="modal-btn primary"
              disabled={busy}
              onClick={() => void run(startOllamaServer)}
            >
              {server.restartNeeded ? "Restart to apply" : "Restart"}
            </button>
            <button
              type="button"
              className="modal-btn"
              disabled={busy}
              onClick={() => void run(stopOllamaServer)}
            >
              Stop
            </button>
          </>
        )}
        {!server.managed && !server.running && server.canStart && (
          <button
            type="button"
            className="modal-btn primary"
            disabled={busy}
            onClick={() => void run(startOllamaServer)}
          >
            Start Ollama
          </button>
        )}
      </div>
    </form>
  );
}
