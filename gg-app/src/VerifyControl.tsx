import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { runVerify, setVerify, type VerifyCommandSpec, type VerifyState } from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover } from "./popover";
import { toast } from "./toast";

/** `label: command` lines → specs; null when a line has no label or command. */
export function parseVerifyCommands(text: string): VerifyCommandSpec[] | null {
  const out: VerifyCommandSpec[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const label = line.slice(0, colon).trim();
    const command = line.slice(colon + 1).trim();
    if (!label || !command) return null;
    out.push({ label, command });
  }
  return out;
}

export function formatVerifyCommands(commands: readonly VerifyCommandSpec[]): string {
  return commands.map((c) => `${c.label}: ${c.command}`).join("\n");
}

/**
 * The deck's Verify keys: a switch (run the project's checks after each change
 * and fix failures, up to the round cap) and a settings popover with the
 * commands, the cap and "Run checks now".
 */
export function VerifyControl({
  verify,
  running,
  onChange,
}: {
  verify: VerifyState;
  /** A run is active: checks can't be started by hand. */
  running: boolean;
  onChange: (next: VerifyState) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const popoverId = useId();
  const commandsId = useId();
  const roundsId = useId();
  const [commandsText, setCommandsText] = useState(formatVerifyCommands(verify.config.commands));
  const [maxRounds, setMaxRounds] = useState(verify.config.maxRounds);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCommandsText(formatVerifyCommands(verify.config.commands));
    setMaxRounds(verify.config.maxRounds);
  }, [open, verify.config.commands, verify.config.maxRounds]);

  async function toggle(): Promise<void> {
    const next = !verify.enabled;
    onChange({ ...verify, enabled: next });
    try {
      onChange(await setVerify({ enabled: next }));
    } catch {
      onChange({ ...verify, enabled: !next });
      toast("Couldn't change Verify. Try again.", "error");
    }
  }

  async function save(): Promise<void> {
    const commands = parseVerifyCommands(commandsText);
    if (!commands) {
      toast("Each line needs a label, a colon and a command: `test: npm test`.", "error");
      return;
    }
    setSaving(true);
    try {
      onChange(await setVerify({ commands, maxRounds }));
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function runNow(): Promise<void> {
    try {
      await runVerify();
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const count = verify.config.commands.length;
  return (
    <>
      <button
        type="button"
        className="key"
        role="switch"
        aria-checked={verify.enabled}
        title={`Run the project's checks after each change and fix failures, up to ${verify.config.maxRounds} rounds`}
        onClick={() => void toggle()}
      >
        Verify
        <span className="led" data-state={verify.enabled ? "on" : undefined} aria-hidden="true" />
      </button>
      <button
        ref={anchorRef}
        type="button"
        className="key key-sm"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label="Verify settings"
        title={
          count === 0
            ? "No checks found. Add the commands to run."
            : `${count} ${count === 1 ? "check" : "checks"} (${verify.config.source === "file" ? "from .gg/verify.json" : "detected"})`
        }
        onClick={() => setOpen((v) => !v)}
      >
        {count === 0 ? "No checks" : `${count} ${count === 1 ? "check" : "checks"}`}
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel verify-popover"
              data-side="below"
              role="dialog"
              aria-label="Verify settings"
              style={style}
            >
              <h2 className="pop-title">Verify</h2>
              <p className="verify-help">
                One check per line, as <code>label: command</code>. Saved to the project's{" "}
                <code>.gg/verify.json</code>.
              </p>
              <label className="verify-field" htmlFor={commandsId}>
                Checks
              </label>
              <textarea
                id={commandsId}
                className="verify-commands"
                rows={4}
                spellCheck={false}
                value={commandsText}
                placeholder={"test: npm test\ntypecheck: tsc --noEmit"}
                onChange={(e) => setCommandsText(e.target.value)}
              />
              <label className="verify-field" htmlFor={roundsId}>
                Rounds (1–10)
                <input
                  id={roundsId}
                  type="number"
                  min={1}
                  max={10}
                  value={maxRounds}
                  onChange={(e) =>
                    setMaxRounds(Math.min(10, Math.max(1, Math.floor(Number(e.target.value) || 1))))
                  }
                />
              </label>
              <div className="verify-actions">
                <button
                  type="button"
                  className="key key-sm"
                  disabled={running || verify.running || count === 0}
                  title={running ? "Wait for the current run to finish" : undefined}
                  onClick={() => void runNow()}
                >
                  Run checks now
                </button>
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
