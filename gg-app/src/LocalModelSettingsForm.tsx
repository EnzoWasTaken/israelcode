import { useId, useState } from "react";
import { theme } from "./theme";
import {
  setLocalModelSettings,
  type LocalEndpointRow,
  type LocalModelRow,
  type LocalModelSettings,
  type LocalModelsState,
} from "./agent";

interface Props {
  model: LocalModelRow;
  endpointKind: LocalEndpointRow["kind"];
  onSaved: (state: LocalModelsState) => void;
  onClose: () => void;
}

type NumberKey =
  "contextWindow" | "maxOutputTokens" | "topK" | "seed" | "gpuLayers" | "batchSize" | "threads";
type FloatKey = "temperature" | "topP" | "repeatPenalty";
type CapKey = "supportsTools" | "supportsImages" | "supportsThinking";

const NUMBER_FIELDS: { key: NumberKey | FloatKey; label: string; hint?: string }[] = [
  { key: "contextWindow", label: "Context window" },
  { key: "maxOutputTokens", label: "Max output tokens", hint: "At most half the context window." },
  { key: "temperature", label: "Temperature" },
  { key: "topP", label: "Top P" },
  { key: "topK", label: "Top K" },
  { key: "repeatPenalty", label: "Repeat penalty" },
  { key: "seed", label: "Seed" },
];

// Ollama applies these through a derived model copy; other servers ignore them.
const OLLAMA_FIELDS: { key: NumberKey; label: string; hint: string }[] = [
  { key: "gpuLayers", label: "GPU layers", hint: "Empty = Ollama fits layers automatically." },
  { key: "batchSize", label: "Batch size", hint: "Tokens processed per batch (1-8192)." },
  { key: "threads", label: "CPU threads", hint: "Empty = Ollama picks." },
];

const CAPS: { key: CapKey; label: string }[] = [
  { key: "supportsTools", label: "Tools" },
  { key: "supportsImages", label: "Images" },
  { key: "supportsThinking", label: "Reasoning" },
];

function initialText(settings: LocalModelSettings, key: string): string {
  const v = (settings as Record<string, unknown>)[key];
  return typeof v === "number" ? String(v) : "";
}

function capValue(v: boolean | undefined): string {
  return v === undefined ? "auto" : v ? "on" : "off";
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

export function LocalModelSettingsForm({
  model,
  endpointKind,
  onSaved,
  onClose,
}: Props): React.ReactElement {
  const uid = useId();
  const settings = model.settings ?? {};
  const detected = model.detected ?? {
    contextWindow: model.contextWindow,
    contextWindowKnown: model.contextWindowKnown,
    supportsTools: model.supportsTools,
    supportsImages: model.supportsImages,
    supportsThinking: model.supportsThinking,
  };
  const fields: { key: NumberKey | FloatKey; label: string; hint?: string }[] =
    endpointKind === "ollama" ? [...NUMBER_FIELDS, ...OLLAMA_FIELDS] : NUMBER_FIELDS;
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      [...NUMBER_FIELDS, ...OLLAMA_FIELDS].map((f) => [f.key, initialText(settings, f.key)]),
    ),
  );
  const [caps, setCaps] = useState<Record<CapKey, string>>(() => ({
    supportsTools: capValue(settings.supportsTools),
    supportsImages: capValue(settings.supportsImages),
    supportsThinking: capValue(settings.supportsThinking),
  }));
  const [extra, setExtra] = useState(
    settings.extraBody && Object.keys(settings.extraBody).length > 0
      ? JSON.stringify(settings.extraBody, null, 2)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let extraError: string | null = null;
  if (extra.trim()) {
    try {
      const parsed: unknown = JSON.parse(extra);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        extraError = 'Extra request body must be a JSON object, like {"key": "value"}.';
      }
    } catch (e) {
      extraError = `Extra request body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function build(): LocalModelSettings | string {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = (text[f.key] ?? "").trim().replace(/[,_\s]/g, "");
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${f.label} must be a number.`;
      out[f.key] = n;
    }
    for (const c of CAPS) {
      if (caps[c.key] !== "auto") out[c.key] = caps[c.key] === "on";
    }
    if (extra.trim()) out.extraBody = JSON.parse(extra) as Record<string, unknown>;
    return out as LocalModelSettings;
  }

  async function submit(next: LocalModelSettings | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await setLocalModelSettings(model.id, next));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save(): void {
    if (extraError) return;
    const built = build();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    void submit(built);
  }

  const inputStyle = { color: theme.text, background: theme.inputBackground, width: "100%" };

  function renderField(f: { key: NumberKey | FloatKey; label: string; hint?: string }) {
    const id = `${uid}-${f.key}`;
    const placeholder =
      f.key === "contextWindow"
        ? detected.contextWindowKnown
          ? detected.contextWindow.toLocaleString("en-US")
          : "Unknown"
        : f.key === "gpuLayers"
          ? "Auto"
          : "Server default";
    return (
      <div key={f.key}>
        <label className="modal-label" htmlFor={id} style={{ color: theme.textMuted }}>
          {f.label}
        </label>
        <input
          id={id}
          className="modal-input"
          style={inputStyle}
          inputMode="decimal"
          value={text[f.key] ?? ""}
          placeholder={placeholder}
          onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
        />
        {f.hint && (
          <div className="modal-hint" style={{ color: theme.textDim }}>
            {f.hint}
          </div>
        )}
      </div>
    );
  }

  return (
    <form
      className="local-model-settings"
      aria-label={`Settings for ${model.rawId}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="local-model-settings-grid">{NUMBER_FIELDS.map((f) => renderField(f))}</div>
      {endpointKind === "ollama" && (
        <>
          <div className="modal-hint" style={{ color: theme.textDim }}>
            Sent to Ollama as num_ctx.
          </div>
          <fieldset className="local-model-settings-group">
            <legend style={{ color: theme.textMuted }}>Ollama load settings</legend>
            <div className="local-model-settings-grid">
              {OLLAMA_FIELDS.map((f) => renderField(f))}
            </div>
            <div className="modal-hint" style={{ color: theme.textDim }}>
              Applied through a copy of the model named {model.rawId}-israelcode. The model reloads
              the next time it is used.
            </div>
          </fieldset>
        </>
      )}
      <div className="local-model-settings-grid">
        {CAPS.map((c) => {
          const id = `${uid}-${c.key}`;
          return (
            <div key={c.key}>
              <label className="modal-label" htmlFor={id} style={{ color: theme.textMuted }}>
                {c.label}
              </label>
              <select
                id={id}
                className="modal-input"
                style={inputStyle}
                value={caps[c.key]}
                onChange={(e) => setCaps({ ...caps, [c.key]: e.target.value })}
              >
                <option value="auto">Auto (detected: {yesNo(detected[c.key])})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
          );
        })}
      </div>
      {endpointKind === "ollama" && (
        <div className="modal-hint" style={{ color: theme.textDim }}>
          Vision adapter (mmproj): bundled with the model by Ollama. Detected:{" "}
          {yesNo(detected.supportsImages)}
        </div>
      )}
      <label className="modal-label" htmlFor={`${uid}-extra`} style={{ color: theme.textMuted }}>
        Extra request body
      </label>
      <textarea
        id={`${uid}-extra`}
        className="modal-input"
        style={{ ...inputStyle, minHeight: 64, fontFamily: "var(--font-mono, monospace)" }}
        value={extra}
        placeholder='{"num_gpu": 99}'
        spellCheck={false}
        aria-invalid={extraError ? true : undefined}
        onChange={(e) => setExtra(e.target.value)}
      />
      {extraError && (
        <div className="login-status" role="alert" style={{ color: theme.error }}>
          {extraError}
        </div>
      )}
      {error && (
        <div className="login-status" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="local-model-settings-actions">
        <button
          type="button"
          className="modal-btn"
          onClick={() => void submit(null)}
          disabled={busy}
        >
          Reset
        </button>
        <button type="button" className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="modal-btn primary" disabled={busy || !!extraError}>
          {busy ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </form>
  );
}
