import type { UltracodePhase } from "./ultracode-phases";

const MARK: Record<UltracodePhase["status"], string> = { pending: "○", active: "◐", done: "✓" };

/** Ultracode's plan → build → review → combine strip, at the top of its turn. */
export function UltracodePhases({
  phases,
}: {
  phases: readonly UltracodePhase[];
}): React.ReactElement {
  return (
    <ol className="ultracode-phases" aria-label="Ultracode phases">
      {phases.map((phase) => (
        <li key={phase.id} className="ultracode-phase" data-status={phase.status}>
          <span className="todo-mark" aria-hidden="true">
            {MARK[phase.status]}
          </span>
          <span className="ultracode-phase-label">{phase.label}</span>
          {phase.detail && <span className="ultracode-phase-detail">{phase.detail}</span>}
          <span className="sr-only">{`, ${phase.status === "active" ? "in progress" : phase.status}`}</span>
        </li>
      ))}
    </ol>
  );
}
