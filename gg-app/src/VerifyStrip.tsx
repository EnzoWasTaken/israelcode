import type { VerifyItem, VerifyItemCheck } from "./transcript-item";

/**
 * The verify loop for one turn: a block per round listing each check with its
 * mark and exit code, the failing output behind a <details>, and a closing
 * line once the loop has ended.
 */
export function VerifyStrip({ item }: { item: VerifyItem }) {
  const lastRound = item.rounds[item.rounds.length - 1]?.round ?? 0;
  return (
    <div className="verify-strip" data-state={stateOf(item)} role="group" aria-label="Verify">
      {item.rounds.map((round) => (
        <div className="verify-round" key={round.round}>
          <div className="verify-round-title">
            Round {round.round}/{item.maxRounds}
          </div>
          {round.checks.map((check) => (
            <VerifyCheck key={check.command} check={check} />
          ))}
        </div>
      ))}
      {item.result && (
        <div className="verify-final">{finalLine(item.result, lastRound, item.rounds.length)}</div>
      )}
    </div>
  );
}

function VerifyCheck({ check }: { check: VerifyItemCheck }) {
  const mark = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "…";
  const detail =
    check.status === "running"
      ? "running"
      : check.exitCode === null || check.exitCode === undefined
        ? "no exit code"
        : `exit ${check.exitCode}`;
  const output = check.tail?.trim();
  return (
    <div className="verify-check" data-status={check.status}>
      <div className="verify-check-line">
        <span className="verify-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="verify-label">{check.label}</span>
        <code className="verify-command">{check.command}</code>
        <span className="verify-detail">{detail}</span>
      </div>
      {output && check.status !== "running" && (
        <details className="verify-tail">
          <summary>Output</summary>
          <pre>{output}</pre>
        </details>
      )}
    </div>
  );
}

function stateOf(item: VerifyItem): "running" | "pass" | "fail" | "stopped" {
  if (!item.result) return "running";
  if (item.result.passed) return "pass";
  return item.result.stoppedReason === "cancelled" ? "stopped" : "fail";
}

export function finalLine(
  result: NonNullable<VerifyItem["result"]>,
  lastRound: number,
  roundCount: number,
): string {
  if (result.passed) return `All checks green on round ${lastRound}`;
  if (result.stoppedReason === "cancelled") return "Stopped";
  return `Still failing after ${roundCount} ${roundCount === 1 ? "round" : "rounds"}`;
}
