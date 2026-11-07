import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { budgetContinue, setBudget, type BudgetState } from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover } from "./popover";
import { toast } from "./toast";

/** 1,234,567 → "1.2M"; 200,000 → "200k"; 900 → "0.9k". Tokens, never money. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

const PRESETS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "200k", value: 200_000 },
  { label: "1M", value: 1_000_000 },
  { label: "5M", value: 5_000_000 },
  { label: "None", value: null },
];

function CapPicker({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}): React.ReactElement {
  return (
    <div className="budget-cap">
      <label htmlFor={id} className="budget-cap-label">
        {label}
      </label>
      <div className="key-group" role="group" aria-label={`${label} presets`}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="key key-sm"
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        id={id}
        className="budget-cap-input"
        type="number"
        min={1}
        step={1000}
        placeholder="tokens"
        value={value ?? ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(e.target.value === "" || !Number.isFinite(n) || n <= 0 ? null : Math.floor(n));
        }}
      />
    </div>
  );
}

/**
 * Title-bar token meter: `used / cap tokens` for this session, coloured by
 * how close it is. Click opens the caps (session and day), the runaway
 * hard-stop switch and, once a cap is used up, "Continue anyway".
 * Hidden entirely while no session cap is set, unless `alwaysShow`.
 */
export function BudgetMeter({
  budget,
  onChange,
}: {
  budget: BudgetState;
  onChange: (next: BudgetState) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const popoverId = useId();
  const sessionId = useId();
  const dayId = useId();
  const { status, config } = budget;
  const [sessionCap, setSessionCap] = useState<number | null>(status.sessionCap);
  const [dayCap, setDayCap] = useState<number | null>(status.dayCap);
  const [hardStop, setHardStop] = useState(config.hardStopOnRunaway);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSessionCap(status.sessionCap);
    setDayCap(status.dayCap);
    setHardStop(config.hardStopOnRunaway);
  }, [open, status.sessionCap, status.dayCap, config.hardStopOnRunaway]);

  const tone =
    status.level === "exceeded" && !status.overridden
      ? "exceeded"
      : status.level === "warn80" || status.level === "warn50"
        ? "warn"
        : "ok";
  const dayText =
    status.dayCap !== null
      ? `Today: ${formatTokens(status.dayUsed)} of ${formatTokens(status.dayCap)} tokens`
      : `Today: ${formatTokens(status.dayUsed)} tokens, no day cap`;

  async function save(): Promise<void> {
    setSaving(true);
    try {
      onChange(
        await setBudget({
          sessionTokens: sessionCap,
          dayTokens: dayCap,
          hardStopOnRunaway: hardStop,
        }),
      );
      setOpen(false);
    } catch {
      toast("Couldn't save the budget. Try again.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function continueAnyway(): Promise<void> {
    try {
      onChange(await budgetContinue());
      setOpen(false);
    } catch {
      toast("Couldn't lift the cap. Try again.", "error");
    }
  }

  const pill =
    status.sessionCap !== null
      ? `${formatTokens(status.sessionUsed)} / ${formatTokens(status.sessionCap)} tokens`
      : status.dayCap !== null
        ? `${formatTokens(status.dayUsed)} / ${formatTokens(status.dayCap)} today`
        : null;
  if (pill === null) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="key key-sm budget-pill"
        data-tone={tone}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Token budget: ${pill}. ${dayText}. Open budget settings`}
        title={dayText}
        onClick={() => setOpen((v) => !v)}
      >
        {pill}
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel budget-popover"
              data-side="below"
              role="dialog"
              aria-label="Token budget"
              style={style}
            >
              <h2 className="pop-title">Token budget</h2>
              <p className="budget-figures">
                This session: {formatTokens(status.sessionUsed)} tokens. {dayText}.
              </p>
              {status.level === "exceeded" && !status.overridden && (
                <div className="budget-exceeded" role="status">
                  <p>The run stopped at the cap.</p>
                  <button
                    type="button"
                    className="key key-sm"
                    onClick={() => void continueAnyway()}
                  >
                    Continue anyway
                  </button>
                </div>
              )}
              {status.overridden && (
                <p className="budget-figures">Caps are off for this session.</p>
              )}
              <CapPicker
                id={sessionId}
                label="Session cap"
                value={sessionCap}
                onChange={setSessionCap}
              />
              <CapPicker
                id={dayId}
                label="Day cap (this project)"
                value={dayCap}
                onChange={setDayCap}
              />
              <label className="budget-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={hardStop}
                  checked={hardStop}
                  onChange={(e) => setHardStop(e.target.checked)}
                />
                Stop a run that keeps going in circles
              </label>
              <div className="budget-actions">
                <button
                  type="button"
                  className="key key-sm"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}
