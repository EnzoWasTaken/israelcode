import { useEffect, useState } from "react";
import { PauseIcon, PlayIcon, RadioIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { Dropdown } from "./Dropdown";
import { useRadio } from "./useRadio";

/** Titlebar control and modal player for the app-wide internet radio. */
export function RadioButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const radio = useRadio();
  const { stations, selected, current, volume, busy, error, refresh } = radio;

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const playing = current !== null;
  const selectedStation = stations.find((station) => station.id === selected);

  return (
    <>
      <button
        className="btn btn-ghost btn-sm btn-nav-icon"
        aria-label="Internet radio"
        title={playing ? "Radio playing" : "Internet radio"}
        style={playing ? { color: theme.accent } : undefined}
        onClick={() => setOpen(true)}
      >
        <RadioIcon size={16} />
      </button>
      {open && (
        <Modal title="Internet Radio" onClose={() => setOpen(false)} className="radio-modal">
          <label className="modal-label" style={{ color: theme.textMuted }}>
            Station
          </label>
          <Dropdown
            label="Station"
            options={stations.map((station) => ({
              value: station.id,
              label: station.name,
              description: station.description,
            }))}
            value={selected}
            disabled={busy || stations.length === 0}
            placeholder={stations.length === 0 ? "Loading stations\u2026" : "Choose a station"}
            onChange={radio.changeStation}
          />
          <div className="modal-hint radio-station-description" style={{ color: theme.textDim }}>
            {selectedStation?.description ?? "Choose a station to start listening."}
          </div>

          <div className="radio-player-row">
            <button
              className="modal-btn primary radio-play-button"
              disabled={busy || !selected}
              onClick={radio.togglePlayback}
            >
              {playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
              {playing ? "Pause" : "Play"}
            </button>
          </div>

          <div className="radio-volume-heading">
            <label className="modal-label" style={{ color: theme.textMuted }}>
              Volume
            </label>
            <span style={{ color: theme.textDim }}>{volume}%</span>
          </div>
          <div className="radio-volume-row">
            <SpeakerHighIcon size={17} color={theme.textMuted} />
            <div className="radio-volume-slider">
              <div className="radio-volume-track">
                <div className="radio-volume-fill" style={{ width: `${volume}%` }} />
              </div>
              <input
                className="radio-volume-input"
                type="range"
                min="0"
                max="100"
                value={volume}
                aria-label="Radio volume"
                onChange={(event) => radio.updateVolume(Number(event.target.value))}
                onPointerUp={radio.saveVolume}
                onPointerCancel={radio.saveVolume}
                onKeyUp={radio.saveVolume}
                onBlur={radio.saveVolume}
              />
            </div>
          </div>

          {error && (
            <div className="modal-hint" style={{ color: theme.error }}>
              {error}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
