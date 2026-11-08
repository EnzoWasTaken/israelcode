import { useEffect, useRef, useState } from "react";
import { BackButton } from "./BackButton";
import { SettingsReadyProvider, useSettingsPageGate } from "./settings-ready";
import { SettingsHeaderProvider } from "./settings-header";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsContext,
  type SettingsTabId,
} from "./settings-sections";
import { waitForReady, getSteroidsStatus, onSteroidsChange, type SteroidsStatus } from "./agent";
import "./SettingsScreen.css";

export type { SettingsTabId } from "./settings-sections";

interface Props {
  onClose: () => void;
  /** The tab to open on, e.g. AI Providers when Code needs a provider. */
  initialTab?: SettingsTabId;
}

const KEYS = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];

/**
 * Full-screen Settings, reached from the home screen's Settings button: a
 * grouped section list on the left and the open page on the right (a compact
 * strip on top in narrow windows). Sections come from settings-sections.tsx.
 * Each page is the same panel the app still opens as a dialog from the tray
 * and the chat view, drawn here in page form (see modal-embed.tsx).
 */
export function SettingsScreen({ onClose, initialTab = "general" }: Props): React.ReactElement {
  const [tab, setTab] = useState<SettingsTabId>(initialTab);
  const [steroids, setSteroids] = useState<SteroidsStatus | null>(null);
  // The header elements pages portal their status and buttons into
  // (settings-header.tsx).
  const [statusSlot, setStatusSlot] = useState<HTMLSpanElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLSpanElement | null>(null);
  // The first page rises in like the other screens' rows; later switches crossfade.
  const [switched, setSwitched] = useState(false);
  // Each page stays hidden until its first load lands (settings-ready.tsx).
  const gate = useSettingsPageGate(tab);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void waitForReady()
      .then(() => getSteroidsStatus())
      .then(setSteroids)
      .catch(() => {});
    return onSteroidsChange(setSteroids);
  }, []);

  const current = SETTINGS_SECTIONS.find((s) => s.id === tab);

  function selectTab(id: SettingsTabId): void {
    if (id === tab) return;
    setSwitched(true);
    setTab(id);
  }

  const ctx: SettingsContext = { steroids, setSteroids, stay: () => {}, goTo: selectTab };

  // Arrow keys (and Home/End) move focus through the list; Enter/Space open
  // the focused entry, as buttons do.
  function onNavKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (!KEYS.includes(event.key)) return;
    const items = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-section-id]") ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const last = items.length - 1;
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = at === last ? 0 : at + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = at === 0 ? last : at - 1;
    else if (event.key === "Home") next = 0;
    else next = last;
    items[next]?.focus();
  }

  return (
    <div className={`picker settings-screen${gate.waiting ? " is-waiting" : ""}`}>
      <div className="picker-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        {/* Names the open page; each page's own heading is hidden to match. */}
        <h1 className="picker-title" id="settings-heading">
          {current?.label ?? "Settings"}
        </h1>
        <span className="settings-head-status" ref={setStatusSlot} />
        {/* The open page's buttons, right-aligned on the header's row. */}
        <span className="picker-head-actions settings-head-actions" ref={setActionsSlot} />
      </div>

      <div className="settings-body">
        <nav
          className="settings-nav"
          aria-label="Settings sections"
          ref={navRef}
          onKeyDown={onNavKeyDown}
        >
          {SETTINGS_GROUPS.map((group) => {
            const sections = SETTINGS_SECTIONS.filter((s) => s.group === group.id);
            if (sections.length === 0) return null;
            return (
              <div
                className="settings-nav-group"
                role="group"
                aria-label={group.label || "Help"}
                key={group.id}
              >
                {group.label && (
                  <span className="settings-nav-heading" aria-hidden="true">
                    {group.label}
                  </span>
                )}
                {sections.map((section) => {
                  const SectionIcon = section.icon;
                  const active = section.id === tab;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={active ? "settings-nav-item is-active" : "settings-nav-item"}
                      data-section-id={section.id}
                      aria-current={active ? "page" : undefined}
                      onClick={() => selectTab(section.id)}
                    >
                      <span className="settings-nav-icon">
                        <SectionIcon
                          size={16}
                          weight={active ? "fill" : "regular"}
                          aria-hidden="true"
                        />
                        {section.alert?.(ctx) && (
                          <span
                            className="settings-nav-alert"
                            role="img"
                            aria-label="Needs attention"
                          />
                        )}
                      </span>
                      <span className="settings-nav-label">{section.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <main className="settings-main" aria-labelledby="settings-heading">
          {current && <p className="settings-intro">{current.description}</p>}
          <div
            className="settings-scroll"
            // Remount per tab so each page loads fresh and scroll starts at the top.
            key={tab}
          >
            <SettingsReadyProvider hold={gate.hold}>
              <SettingsHeaderProvider slots={{ status: statusSlot, actions: actionsSlot }}>
                <div
                  className={`settings-page ${switched ? "is-switching" : "is-entering"}${
                    current?.fill ? " is-fill" : ""
                  }`}
                >
                  {current?.render(ctx)}
                </div>
              </SettingsHeaderProvider>
            </SettingsReadyProvider>
          </div>
        </main>
      </div>
    </div>
  );
}
