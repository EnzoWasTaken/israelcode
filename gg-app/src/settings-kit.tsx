import { useId } from "react";

/**
 * Small form pieces shared by the routing / sessions / cost / diagnostics
 * Settings pages: a labelled row (label + one-line help + control) and a
 * checkbox switch row. Styles live in SettingsPages.css.
 */
export function FieldRow({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  /** A validation message shown next to the control. */
  error?: string | null;
  /** Receives the id the control must use so the label is associated. */
  children: (ids: { id: string; describedBy: string | undefined }) => React.ReactNode;
}): React.ReactElement {
  const id = useId();
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const describedBy = [help ? helpId : null, error ? errId : null].filter(Boolean).join(" ");
  return (
    <div className="sp-row">
      <div className="sp-row-text">
        <label className="sp-label" htmlFor={id}>
          {label}
        </label>
        {help && (
          <p className="sp-help" id={helpId}>
            {help}
          </p>
        )}
      </div>
      <div className="sp-row-control">
        {children({ id, describedBy: describedBy || undefined })}
        {error && (
          <p className="sp-error" id={errId} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function CheckRow({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  const id = useId();
  return (
    <div className="sp-row">
      <div className="sp-row-text">
        <label className="sp-label" htmlFor={id}>
          {label}
        </label>
        {help && (
          <p className="sp-help" id={`${id}-help`}>
            {help}
          </p>
        )}
      </div>
      <div className="sp-row-control">
        <input
          id={id}
          type="checkbox"
          className="sp-check"
          checked={checked}
          disabled={disabled}
          aria-describedby={help ? `${id}-help` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
    </div>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
