import { useCallback, useEffect, useRef, useState } from "react";
import {
  getHooks,
  setHooks,
  type CustomHook,
  type HookEvent,
  type HookEventName,
  type HooksConfig,
  type HooksPayload,
} from "./agent";
import { ListSkeleton } from "./Skeleton";
import { SettingsCard } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";
import { theme } from "./theme";
import "./HooksPanel.css";

/**
 * Settings → Hooks: the five hook presets as switches, custom command hooks
 * and recent hook activity. Edits the current window's project
 * (`<project>/.gg/hooks.json`, shared through git); the master switch is per
 * project in gg-app.json. Every change saves straight away (text fields
 * after a short pause).
 */

export const PROTECT_SUGGESTIONS = [".env", "*.pem", ".github/workflows/**"];
const RECENT_SHOWN = 20;
const DEBOUNCE_MS = 600;

const PRESETS: Array<{
  id: keyof HooksConfig["presets"];
  label: string;
  description: string;
}> = [
  {
    id: "formatOnEdit",
    label: "Format after edit",
    description: "Runs the project's formatter on each file the agent writes or edits.",
  },
  {
    id: "lintOnEdit",
    label: "Lint after edit",
    description: "Runs the linter on each edited file; problems are shown to the agent.",
  },
  {
    id: "protectPaths",
    label: "Protect paths",
    description: "The agent can't write or edit files matching these patterns.",
  },
  {
    id: "blockDangerous",
    label: "Block dangerous commands",
    description:
      "Refuses force-push, reset --hard, clean -fd, rm -rf outside the project, publishing and the like.",
  },
  {
    id: "notifyOnFinish",
    label: "Notify when done",
    description: "A desktop notification when a run finishes and this window is in the background.",
  },
];

function useDebounced<T>(value: T, onSettle: (v: T) => void, enabled: boolean): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled) return;
    const t = setTimeout(() => onSettle(value), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // onSettle is stable enough; only the value triggers a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, enabled]);
}

export function HooksPanel(): React.ReactElement {
  const [data, setData] = useState<HooksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globsText, setGlobsText] = useState("");
  const [formatText, setFormatText] = useState("");
  const [lintText, setLintText] = useState("");
  const [draft, setDraft] = useState<{
    event: HookEventName;
    tool: string;
    command: string;
    timeoutMs: string;
  }>({ event: "postToolUse", tool: "", command: "", timeoutMs: "" });
  useSettingsPageReady(data !== null || error !== null);

  useEffect(() => {
    getHooks()
      .then((d) => {
        setData(d);
        setGlobsText(d.config.presets.protectPaths.globs.join("\n"));
        setFormatText(d.config.presets.formatOnEdit.command ?? "");
        setLintText(d.config.presets.lintOnEdit.command ?? "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = useCallback(async (change: { enabled?: boolean; config?: HooksConfig }) => {
    try {
      const next = await setHooks(change);
      setData(next);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const config = data?.config;
  const patch = useCallback(
    (fn: (c: HooksConfig) => HooksConfig) => {
      if (!config) return;
      void save({ config: fn(structuredClone(config)) });
    },
    [config, save],
  );

  useDebounced(
    globsText,
    (text) =>
      patch((c) => {
        c.presets.protectPaths.globs = text
          .split("\n")
          .map((g) => g.trim())
          .filter(Boolean);
        return c;
      }),
    config !== undefined,
  );
  useDebounced(
    formatText,
    (text) =>
      patch((c) => {
        if (text.trim()) c.presets.formatOnEdit.command = text.trim();
        else delete c.presets.formatOnEdit.command;
        return c;
      }),
    config !== undefined,
  );
  useDebounced(
    lintText,
    (text) =>
      patch((c) => {
        if (text.trim()) c.presets.lintOnEdit.command = text.trim();
        else delete c.presets.lintOnEdit.command;
        return c;
      }),
    config !== undefined,
  );

  if (!data || !config) {
    return (
      <div className="settings-card">
        {error ? (
          <div className="modal-error" role="alert" style={{ color: theme.error }}>
            {error}
          </div>
        ) : (
          <ListSkeleton rows={5} />
        )}
      </div>
    );
  }

  function addCustom(): void {
    const command = draft.command.trim();
    if (!command) return;
    const base = (draft.tool.trim() || draft.event).replace(/[^\w-]+/g, "-");
    const taken = new Set(config!.custom.map((h) => h.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const timeout = Number(draft.timeoutMs);
    const hook: CustomHook = {
      id,
      event: draft.event,
      ...(draft.tool.trim() ? { tool: draft.tool.trim() } : {}),
      command,
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.round(timeout * 1000) } : {}),
    };
    patch((c) => {
      c.custom.push(hook);
      return c;
    });
    setDraft({ event: "postToolUse", tool: "", command: "", timeoutMs: "" });
  }

  const recent = data.recent.slice(-RECENT_SHOWN).reverse();

  return (
    <div className="hooks-panel">
      <SettingsCard
        title="Hooks"
        description="Built-in hooks run around the agent's tool calls, no scripts needed. Settings are saved in this project's .gg/hooks.json; the on/off switch is per project on this machine."
      >
        <label className="hooks-switch hooks-master">
          <input
            type="checkbox"
            role="switch"
            aria-checked={data.enabled}
            checked={data.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>
            <strong>Hooks on for this project</strong>
            <span className="modal-hint">Off: no preset or custom hook runs.</span>
          </span>
        </label>
        {error && (
          <div className="modal-error" role="alert" style={{ color: theme.error }}>
            {error}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Presets"
        description="Switch on what you want; each runs with your shell."
      >
        <ul className="hooks-presets">
          {PRESETS.map((p) => {
            const on = config.presets[p.id].enabled;
            return (
              <li key={p.id} className="hooks-preset">
                <label className="hooks-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={on}
                    aria-label={p.label}
                    checked={on}
                    onChange={(e) =>
                      patch((c) => {
                        c.presets[p.id].enabled = e.target.checked;
                        return c;
                      })
                    }
                  />
                  <span>
                    <strong>{p.label}</strong>
                    <span className="modal-hint">{p.description}</span>
                  </span>
                </label>
                {(p.id === "formatOnEdit" || p.id === "lintOnEdit") && (
                  <div className="hooks-preset-body">
                    <div className="modal-hint hooks-detected">
                      Detected:{" "}
                      <code>
                        {(p.id === "formatOnEdit" ? data.detected.format : data.detected.lint) ??
                          "nothing for this project"}
                      </code>
                    </div>
                    <input
                      className="modal-input"
                      aria-label={`${p.label} command override`}
                      placeholder="Override, e.g. prettier --write {file}"
                      value={p.id === "formatOnEdit" ? formatText : lintText}
                      onChange={(e) =>
                        p.id === "formatOnEdit"
                          ? setFormatText(e.target.value)
                          : setLintText(e.target.value)
                      }
                    />
                    <div className="modal-hint">
                      {"{file}"} is replaced with the edited file; without it the file is appended.
                    </div>
                  </div>
                )}
                {p.id === "protectPaths" && (
                  <div className="hooks-preset-body">
                    <textarea
                      className="modal-input hooks-globs"
                      aria-label="Protected path patterns"
                      placeholder={PROTECT_SUGGESTIONS.join("\n")}
                      rows={4}
                      value={globsText}
                      onChange={(e) => setGlobsText(e.target.value)}
                    />
                    <div className="modal-hint">
                      One pattern per line (<code>*</code>, <code>**</code>, <code>?</code>).
                      Suggestions: {PROTECT_SUGGESTIONS.join(", ")}.
                      {globsText.trim() === "" && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="key key-sm"
                            onClick={() => setGlobsText(PROTECT_SUGGESTIONS.join("\n"))}
                          >
                            Use suggestions
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      <SettingsCard
        title="Custom hooks"
        description="Your own command before or after a tool, or when a run stops. Exit code 2 blocks the call and shows the output to the agent."
      >
        {config.custom.length > 0 && (
          <ul className="hooks-custom-list">
            {config.custom.map((h) => (
              <li key={h.id} className="hooks-custom">
                <span className="hooks-custom-meta">
                  <strong>{h.id}</strong> · {h.event}
                  {h.tool ? ` · ${h.tool}` : ""}
                  {h.timeoutMs ? ` · ${Math.round(h.timeoutMs / 1000)}s` : ""}
                </span>
                <code className="hooks-custom-cmd">{h.command}</code>
                <button
                  type="button"
                  className="key key-sm"
                  aria-label={`Remove hook ${h.id}`}
                  onClick={() =>
                    patch((c) => {
                      c.custom = c.custom.filter((x) => x.id !== h.id);
                      return c;
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="hooks-add">
          <select
            className="modal-input"
            aria-label="Hook event"
            value={draft.event}
            onChange={(e) => setDraft({ ...draft, event: e.target.value as HookEventName })}
          >
            <option value="preToolUse">before a tool</option>
            <option value="postToolUse">after a tool</option>
            <option value="stop">when a run stops</option>
          </select>
          <input
            className="modal-input"
            aria-label="Hook tool"
            placeholder="tool (optional), e.g. bash"
            value={draft.tool}
            disabled={draft.event === "stop"}
            onChange={(e) => setDraft({ ...draft, tool: e.target.value })}
          />
          <input
            className="modal-input hooks-add-cmd"
            aria-label="Hook command"
            placeholder="command, e.g. ./scripts/check.sh {file}"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustom();
            }}
          />
          <input
            className="modal-input hooks-add-timeout"
            aria-label="Hook timeout in seconds"
            placeholder="60s"
            inputMode="numeric"
            value={draft.timeoutMs}
            onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value })}
          />
          <button
            type="button"
            className="key key-sm"
            onClick={addCustom}
            disabled={!draft.command.trim()}
          >
            Add
          </button>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Recent hook activity"
        description="The last hooks that ran in this window."
      >
        {recent.length === 0 ? (
          <div className="modal-hint">
            Nothing yet. Each hook that runs in this window shows up here.
          </div>
        ) : (
          <ul className="hooks-recent" aria-label="Recent hook activity">
            {recent.map((ev: HookEvent, i) => (
              <li key={`${ev.hookId}-${i}`} className="hooks-recent-row" data-outcome={ev.outcome}>
                <span className="hooks-recent-outcome">{ev.outcome}</span>
                <span className="hooks-recent-label">
                  {ev.label} · {ev.tool}
                  {ev.durationMs !== undefined ? ` · ${ev.durationMs} ms` : ""}
                </span>
                {ev.detail && <code className="hooks-recent-detail">{ev.detail}</code>}
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
