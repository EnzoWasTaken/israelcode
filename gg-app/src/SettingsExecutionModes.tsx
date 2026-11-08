import { SettingsCard } from "./settings-section";
import "./SettingsPages.css";

/**
 * Settings → Execution modes. Read-only: Ultracode and Orchestrate are saved
 * through `setUltracode` / `setOrchestrate`, which need a window's coding
 * session (waitForReady), and Settings can be open from Home with none. So this
 * page explains the modes and points at where to change them.
 */
export function SettingsExecutionModes({
  onOpenAutoRouting,
}: {
  onOpenAutoRouting: () => void;
}): React.ReactElement {
  return (
    <>
      <SettingsCard
        title="How a run is carried out"
        description="Every prompt runs in one of three modes."
      >
        <dl className="sp-defs">
          <div>
            <dt>Standard</dt>
            <dd>One agent works through your request step by step. The default.</dd>
          </div>
          <div>
            <dt>Ultracode</dt>
            <dd>
              For big jobs: the agent plans, splits the work and runs many helper agents at once (up
              to 12 instead of the usual limit).
            </dd>
          </div>
          <div>
            <dt>Orchestrate</dt>
            <dd>
              The main model plans, hands the pieces to Worker-model helpers, and reviews their
              results before replying to you.
            </dd>
          </div>
        </dl>
      </SettingsCard>
      <SettingsCard
        title="Where to change it"
        description="Ultracode and Orchestrate belong to a coding window."
      >
        <p className="sp-help">
          Change it from a code window&rsquo;s ⋯ menu; the choice also becomes the default for new
          windows. You can also type &ldquo;ultracode&rdquo; or &ldquo;orchestrate&rdquo; in a
          prompt to use that mode for just that run.
        </p>
        <p className="sp-help">
          Prefer to let the app decide?{" "}
          <button type="button" className="sp-link" onClick={onOpenAutoRouting}>
            Let Auto choose in Auto routing
          </button>
          . A mode you pick yourself in a window always overrides Auto.
        </p>
      </SettingsCard>
    </>
  );
}
