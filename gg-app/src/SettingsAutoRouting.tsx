import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { SettingsCard } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";
import { ConfirmModal } from "./ConfirmModal";
import { CheckRow, FieldRow, errorText } from "./settings-kit";
import {
  getRoutingConfig,
  setRoutingConfig,
  setRoutingCredential,
  clearRoutingCredential,
  testRouting,
  type AutoRouteConfig,
  type RoutingConfigResponse,
  type RoutingDeciderOption,
  type RoutingTestResult,
  type ThinkingLevelName,
} from "./agent";
import "./SettingsPages.css";

const EFFORTS: ThinkingLevelName[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const NO_DECIDER = "";

function optionFor(
  options: readonly RoutingDeciderOption[],
  decider: AutoRouteConfig["decider"],
): RoutingDeciderOption | undefined {
  if (!decider) return undefined;
  return options.find((o) =>
    decider.kind === "model"
      ? o.kind === "model" && o.provider === decider.provider && o.model === decider.model
      : o.kind === "decisions-api" && o.service === decider.service && o.model === decider.model,
  );
}

function deciderFromOption(o: RoutingDeciderOption): AutoRouteConfig["decider"] {
  return o.kind === "model"
    ? { kind: "model", provider: o.provider ?? "", model: o.model }
    : { kind: "decisions-api", service: o.service ?? "openrouter", model: o.model };
}

const FIELD_NAMES: Record<keyof Fields, string> = {
  threshold: "Confidence threshold",
  attempts: "Escalation attempts",
  timeoutSec: "Decision timeout",
};

/** Editable numeric fields are kept as text so half-typed values aren't clobbered. */
interface Fields {
  threshold: string;
  attempts: string;
  timeoutSec: string;
}

function toFields(c: AutoRouteConfig): Fields {
  return {
    threshold: String(c.confidenceThreshold),
    attempts: String(c.escalation.maxAttempts),
    timeoutSec: String(c.timeoutMs / 1000),
  };
}

function parseFields(
  f: Fields,
  escalation: AutoRouteConfig["escalation"],
): {
  values: { threshold: number; attempts: number; timeoutMs: number } | null;
  errors: Partial<Record<keyof Fields, string>>;
} {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const threshold = f.threshold.trim() === "" ? NaN : Number(f.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    errors.threshold = "Enter a number from 0 to 1.";
  const attempts = f.attempts.trim() === "" ? NaN : Number(f.attempts);
  if (escalation.enabled && (!Number.isInteger(attempts) || attempts < 0 || attempts > 2))
    errors.attempts = "Enter 0, 1 or 2.";
  const sec = f.timeoutSec.trim() === "" ? NaN : Number(f.timeoutSec);
  if (!Number.isFinite(sec) || sec < 1 || sec > 15) errors.timeoutSec = "Enter 1 to 15 seconds.";
  if (Object.keys(errors).length > 0) return { values: null, errors };
  return {
    values: {
      threshold,
      attempts: escalation.enabled ? attempts : escalation.maxAttempts,
      timeoutMs: Math.round(sec * 1000),
    },
    errors,
  };
}

/** Settings → Auto routing. Global defaults; each window can still switch Auto off or pin choices. */
export function SettingsAutoRouting(): React.ReactElement {
  const [resp, setResp] = useState<RoutingConfigResponse | null>(null);
  const [draft, setDraft] = useState<AutoRouteConfig | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    { kind: "saved" } | { kind: "error"; message: string } | null
  >(null);
  const [test, setTest] = useState<RoutingTestResult | { pending: true } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useSettingsPageReady(loaded);

  const adopt = useCallback((r: RoutingConfigResponse) => {
    setResp(r);
    setDraft(r.config);
    setFields(toFields(r.config));
  }, []);

  useEffect(() => {
    let live = true;
    getRoutingConfig()
      .then((r) => {
        if (live) adopt(r);
      })
      .catch((e) => {
        if (live) setLoadError(errorText(e));
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [adopt]);

  /** Credentials changed: refresh status and decider availability, keep unsaved edits. */
  const refreshAfterCredential = useCallback(async () => {
    const r = await getRoutingConfig();
    setResp(r);
  }, []);

  const parsed = useMemo(
    () => (fields && draft ? parseFields(fields, draft.escalation) : null),
    [fields, draft],
  );
  const candidate: AutoRouteConfig | null = useMemo(() => {
    if (!draft || !parsed?.values) return null;
    return {
      ...draft,
      confidenceThreshold: parsed.values.threshold,
      escalation: { ...draft.escalation, maxAttempts: parsed.values.attempts },
      timeoutMs: parsed.values.timeoutMs,
    };
  }, [draft, parsed]);
  const dirty = !!resp && !!candidate && JSON.stringify(candidate) !== JSON.stringify(resp.config);
  const valid = candidate !== null;

  async function save(): Promise<void> {
    if (!candidate || saving) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      adopt(await setRoutingConfig(candidate));
      setSaveStatus({ kind: "saved" });
    } catch (e) {
      setSaveStatus({ kind: "error", message: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  async function runTest(): Promise<void> {
    setTest({ pending: true });
    try {
      setTest(await testRouting());
    } catch (e) {
      setTest({
        ok: false,
        latencyMs: 0,
        decider: "",
        error: { reason: "error", message: errorText(e) },
      });
    }
  }

  if (loadError) {
    return (
      <SettingsCard title="Auto routing" description="Couldn't load the routing settings.">
        <p className="sp-error" role="alert">
          {loadError}
        </p>
      </SettingsCard>
    );
  }
  if (!resp || !draft || !fields || !parsed) {
    return (
      <SettingsCard title="Auto routing" description="Loading\u2026">
        <span className="sr-only" role="status">
          Loading routing settings
        </span>
      </SettingsCard>
    );
  }

  const selected = optionFor(resp.deciderOptions, draft.decider);
  // A saved decider that no longer appears in the list still has to show.
  const selectValue = draft.decider ? (selected?.id ?? "__saved") : NO_DECIDER;
  const setField = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields({ ...fields, [k]: e.target.value });

  return (
    <>
      <SettingsCard
        title="Auto routing"
        description="Auto picks the model, effort and mode for each prompt from a small, fast decision."
      >
        <CheckRow
          label="Use Auto for new windows"
          help="Each window can still switch Auto off or on from its model control. A model, effort or mode you pick yourself in a window always overrides Auto for that window."
          checked={draft.enabled}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
        />
        <FieldRow
          label="Decision model"
          help="The model that makes the routing choice. Without one, Auto uses built-in rules."
        >
          {({ id, describedBy }) => (
            <select
              id={id}
              className="sp-select"
              aria-describedby={describedBy}
              value={selectValue}
              onChange={(e) => {
                const o = resp.deciderOptions.find((x) => x.id === e.target.value);
                setDraft({ ...draft, decider: o ? deciderFromOption(o) : null });
                setTest(null);
              }}
            >
              <option value={NO_DECIDER}>Built-in rules (no decision model)</option>
              {selectValue === "__saved" && draft.decider && (
                <option value="__saved" disabled>
                  {draft.decider.model} (not available)
                </option>
              )}
              {resp.deciderOptions.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.available}>
                  {o.label}
                  {!o.available && o.note ? ` \u2014 ${o.note}` : ""}
                </option>
              ))}
            </select>
          )}
        </FieldRow>
        {resp.problems.length > 0 && (
          <ul className="sp-list" aria-label="Things to fix">
            {resp.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="sp-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!valid || !dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <span className="sp-status" role="status" aria-live="polite">
            {saveStatus?.kind === "saved" && !dirty && <span className="sp-ok">Saved</span>}
            {!valid && (
              <span className="sp-error">
                Fix to save:{" "}
                {Object.entries(parsed.errors)
                  .map(([k, msg]) => `${FIELD_NAMES[k as keyof Fields]}: ${msg}`)
                  .join(" ")}
              </span>
            )}
          </span>
        </div>
        {saveStatus?.kind === "error" && (
          <p className="sp-error" role="alert">
            Couldn&rsquo;t save: {saveStatus.message}
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Decision service keys"
        description="Only needed if the decision model runs through OpenRouter or TypeSafe. Keys are stored on this computer and never shown again."
      >
        <KeyBlock
          service="openrouter"
          name="OpenRouter key"
          status={resp.credentials.openrouter}
          setHelp="Uses your OpenRouter provider login. Replace it only if you mean to; it's the same key your OpenRouter sign-in uses."
          unsetHelp="Used for the OpenRouter decision models."
          onChanged={refreshAfterCredential}
        />
        <KeyBlock
          service="typesafe"
          name="TypeSafe key"
          status={resp.credentials.typesafe}
          setHelp="Used for Jev via TypeSafe."
          unsetHelp="Used for Jev via TypeSafe."
          onChanged={refreshAfterCredential}
        />
        <div className="sp-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!resp.config.decider || (test !== null && "pending" in test)}
            onClick={() => void runTest()}
          >
            Test connection
          </button>
          <span className="sp-help">Tests the saved decision model with a sample prompt.</span>
        </div>
        <div role="status" aria-live="polite" className="sp-status">
          {test && "pending" in test && <span className="sp-help">Testing…</span>}
          {test && !("pending" in test) && test.ok && (
            <span className="sp-ok">
              Works — {test.latencyMs} ms
              {test.sample
                ? `, picked ${test.sample.model}${test.sample.effort ? ` (${test.sample.effort})` : ""}`
                : ""}
              .
            </span>
          )}
          {test && !("pending" in test) && !test.ok && (
            <span className="sp-error">{test.error?.message ?? "The test failed."}</span>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Limits"
        description="Limits Auto stays within. The defaults suit most people."
      >
        <details
          className="sp-disclosure"
          open={advancedOpen || Object.keys(parsed.errors).length > 0}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary>Advanced options</summary>
          <div className="sp-disclosure-body">
            <FieldRow
              label="Confidence threshold"
              help="Below this confidence Auto falls back to built-in rules. 0 to 1."
              error={parsed.errors.threshold}
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className="sp-input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={fields.threshold}
                  aria-invalid={!!parsed.errors.threshold}
                  aria-describedby={describedBy}
                  onChange={setField("threshold")}
                />
              )}
            </FieldRow>
            <FieldRow label="Highest effort Auto may use" help="Caps thinking effort.">
              {({ id, describedBy }) => (
                <select
                  id={id}
                  className="sp-select"
                  aria-describedby={describedBy}
                  value={draft.maxEffort ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      maxEffort: (e.target.value || null) as ThinkingLevelName | null,
                    })
                  }
                >
                  <option value="">No limit</option>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              )}
            </FieldRow>
            <FieldRow
              label="Highest cost tier"
              help="Auto won't pick models above this tier. Paid-per-use models are never picked automatically."
            >
              {({ id, describedBy }) => (
                <select
                  id={id}
                  className="sp-select"
                  aria-describedby={describedBy}
                  value={draft.maxCostTier}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      maxCostTier: e.target.value as AutoRouteConfig["maxCostTier"],
                    })
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High (no limit)</option>
                </select>
              )}
            </FieldRow>
            <CheckRow
              label="Allow Ultracode"
              help="Auto may switch on Ultracode for big jobs."
              checked={draft.allowUltracode}
              onChange={(allowUltracode) => setDraft({ ...draft, allowUltracode })}
            />
            <CheckRow
              label="Allow Orchestrate"
              help="Auto may switch on Orchestrate for multi-step work."
              checked={draft.allowOrchestrate}
              onChange={(allowOrchestrate) => setDraft({ ...draft, allowOrchestrate })}
            />
            <CheckRow
              label="Escalate when a run struggles"
              help="If the first attempt fails, try another suitable model."
              checked={draft.escalation.enabled}
              onChange={(enabled) =>
                setDraft({ ...draft, escalation: { ...draft.escalation, enabled } })
              }
            />
            <FieldRow
              label="Maximum escalation attempts"
              help="0 to 2."
              error={parsed.errors.attempts}
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className="sp-input"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  disabled={!draft.escalation.enabled}
                  value={fields.attempts}
                  aria-invalid={!!parsed.errors.attempts}
                  aria-describedby={describedBy}
                  onChange={setField("attempts")}
                />
              )}
            </FieldRow>
            <FieldRow
              label="Decision timeout (seconds)"
              help="How long Auto waits for the decision before using built-in rules. 1 to 15."
              error={parsed.errors.timeoutSec}
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className="sp-input"
                  type="number"
                  min={1}
                  max={15}
                  step={0.5}
                  value={fields.timeoutSec}
                  aria-invalid={!!parsed.errors.timeoutSec}
                  aria-describedby={describedBy}
                  onChange={setField("timeoutSec")}
                />
              )}
            </FieldRow>
          </div>
        </details>
      </SettingsCard>
    </>
  );
}

/** One decision-service key: masked status, and set / replace / remove. Never holds a stored key. */
function KeyBlock({
  service,
  name,
  status,
  setHelp,
  unsetHelp,
  onChanged,
}: {
  service: "openrouter" | "typesafe";
  name: string;
  status: { set: boolean; masked: string | null };
  setHelp: string;
  unsetHelp: string;
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputId = useId();
  const showInput = !status.set || editing;

  async function store(): Promise<void> {
    if (busy || value.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      await setRoutingCredential(service, value.trim(), status.set);
      setValue("");
      setShown(false);
      setEditing(false);
      await onChanged();
      setMessage({ ok: true, text: "Key saved." });
    } catch (e) {
      // The server's text never contains the key.
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setConfirmRemove(false);
    setBusy(true);
    setMessage(null);
    try {
      await clearRoutingCredential("typesafe");
      await onChanged();
      setMessage({ ok: true, text: "Key removed." });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sp-row">
      <div className="sp-row-text">
        <label className="sp-label" htmlFor={showInput ? inputId : undefined}>
          {name}
        </label>
        <p className="sp-help">{status.set ? setHelp : unsetHelp}</p>
      </div>
      <div className="sp-row-control">
        {status.set && (
          <span className="sp-code" aria-label={`${name} is set`}>
            {status.masked ?? "••••"}
          </span>
        )}
        {showInput && (
          <div className="sp-inline">
            <input
              id={inputId}
              className="sp-input"
              type={shown ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder={status.set ? "New key" : "Paste your key"}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-pressed={shown}
              onClick={() => setShown(!shown)}
            >
              {shown ? "Hide" : "Show"}
            </button>
          </div>
        )}
        <div className="sp-actions">
          {showInput && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || value.trim() === ""}
              onClick={() => void store()}
            >
              {status.set ? "Replace key" : "Save key"}
            </button>
          )}
          {status.set && !editing && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              Replace…
            </button>
          )}
          {editing && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
            >
              Cancel
            </button>
          )}
          {service === "typesafe" && status.set && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              Remove key
            </button>
          )}
        </div>
        <span role="status" aria-live="polite" className="sp-status">
          {message && <span className={message.ok ? "sp-ok" : "sp-error"}>{message.text}</span>}
        </span>
      </div>
      {confirmRemove && (
        <ConfirmModal
          title="Remove the TypeSafe key?"
          message="Auto can't use the TypeSafe decision model until you add a key again."
          confirmLabel="Remove"
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}
