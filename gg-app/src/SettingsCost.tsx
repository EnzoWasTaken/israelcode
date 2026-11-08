import { useEffect, useState } from "react";
import { SettingsCard } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";
import { getRoutingConfig, type AutoRouteConfig } from "./agent";
import "./SettingsPages.css";

const TIER: Record<AutoRouteConfig["maxCostTier"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High (no limit)",
};

/**
 * Settings → Cost & usage. Auto's limits are shown as a summary (one editor:
 * Auto routing). Token budgets are saved per project through a window's coding
 * session (`getBudget` / `setBudget` wait for one), and provider usage
 * (`agent_usage`) also needs a session, so neither can be edited here.
 */
export function SettingsCost({
  onOpenAutoRouting,
}: {
  onOpenAutoRouting: () => void;
}): React.ReactElement {
  const [config, setConfig] = useState<AutoRouteConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useSettingsPageReady(loaded);

  useEffect(() => {
    let live = true;
    getRoutingConfig()
      .then((r) => live && setConfig(r.config))
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <SettingsCard
        title="Auto's cost limits"
        description="What Auto will and won't pick, to keep spending in check."
      >
        {config ? (
          <dl className="sp-defs">
            <div>
              <dt>Highest cost tier</dt>
              <dd>{TIER[config.maxCostTier]}</dd>
            </div>
            <div>
              <dt>Paid-per-use models</dt>
              <dd>Never picked automatically.</dd>
            </div>
            <div>
              <dt>Escalation</dt>
              <dd>
                {config.escalation.enabled
                  ? `On, up to ${config.escalation.maxAttempts} ${config.escalation.maxAttempts === 1 ? "retry" : "retries"} on a stronger choice`
                  : "Off"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="sp-help">{failed ? "Couldn't load Auto's settings." : "Loading…"}</p>
        )}
        <p className="sp-help">
          <button type="button" className="sp-link" onClick={onOpenAutoRouting}>
            Edit in Auto routing
          </button>
        </p>
      </SettingsCard>
      <SettingsCard
        title="Token budgets"
        description="Caps on how much a project may spend, counted in tokens, not dollars."
      >
        <p className="sp-help">
          Budgets are set per project, not globally. Open a code window for the project and set a
          session cap and a daily cap from its budget meter. You get a warning at 50% and 80%, and
          the run stops at 100% unless you choose Continue anyway.
        </p>
      </SettingsCard>
    </>
  );
}
