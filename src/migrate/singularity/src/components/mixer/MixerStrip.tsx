import { Headphones, Mic, Plus, Volume2, VolumeX } from "lucide-react";
import type * as React from "react";
import type { TrackState } from "../../views/shared/types.js";
import { Meter } from "./Meter.js";

const SLOT_IDS = ["insert-slot-1", "insert-slot-2", "insert-slot-3", "insert-slot-4"];

export interface MixerStripProps {
  track: TrackState;
  isMaster?: boolean;
  onMute: () => void;
  onSolo: () => void;
  onArm: () => void;
  onVolume: (volume: number) => void;
  onPan: (pan: number) => void;
  onOpenInsert: (slotIndex: number) => void;
}

export const MixerStrip: React.FC<MixerStripProps> = ({
  track,
  isMaster = false,
  onMute,
  onSolo,
  onArm,
  onVolume,
  onPan,
  onOpenInsert,
}) => {
  const db = gainToDb(track.volume);
  return (
    <div
      role="group"
      aria-label={`${isMaster ? "Master" : track.name} channel strip`}
      style={{
        width: 72,
        minWidth: 72,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "6px 4px",
        borderRight: "1px solid var(--vsdaw-border)",
        backgroundColor: "var(--vsdaw-panel-bg)",
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          backgroundColor: track.color || "var(--vsdaw-button-bg)",
        }}
      />
      <span
        style={{
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontSize: 11,
          fontWeight: 600,
          maxHeight: 90,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {isMaster ? "Master" : track.name}
      </span>

      <div style={{ display: "flex", gap: 2 }}>
        {!isMaster && (
          <>
            <StripButton
              ariaLabel="Mute"
              active={track.muted}
              onClick={onMute}
              color="var(--vsdaw-warning)"
            >
              {track.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
            </StripButton>
            <StripButton
              ariaLabel="Solo"
              active={track.soloed}
              onClick={onSolo}
              color="var(--vsdaw-button-bg)"
            >
              S
            </StripButton>
            <StripButton
              ariaLabel="Arm"
              active={track.armed}
              onClick={onArm}
              color="var(--vsdaw-error)"
            >
              <Mic size={10} />
            </StripButton>
          </>
        )}
      </div>

      <div style={{ flex: 1, width: "100%", display: "flex", gap: 4, justifyContent: "center" }}>
        <Meter value={track.volume} peak={track.volume * 1.05} orientation="vertical" />
        <input
          aria-label="Fader"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={track.volume}
          onChange={(e) => onVolume(Number.parseFloat(e.target.value))}
          style={{
            writingMode: "vertical-rl",
            width: 18,
            accentColor: "var(--vsdaw-button-bg)",
          }}
        />
      </div>

      <span style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{db.toFixed(1)} dB</span>

      <input
        aria-label="Pan"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={track.pan}
        onChange={(e) => onPan(Number.parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "var(--vsdaw-button-bg)" }}
      />

      {!isMaster && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%" }}>
          {SLOT_IDS.map((slotId, i) => {
            const insert = track.inserts[i];
            return (
              <button
                key={slotId}
                type="button"
                aria-label={insert ? `${insert.name} insert slot` : `Insert slot ${i + 1}`}
                title={insert?.name}
                onClick={() => insert && onOpenInsert(i)}
                style={{
                  height: 18,
                  border: "1px dashed var(--vsdaw-border)",
                  borderRadius: 2,
                  backgroundColor: insert
                    ? insert.enabled
                      ? "var(--vsdaw-button-bg)"
                      : "var(--vsdaw-panel-bg)"
                    : "transparent",
                  color: insert ? "var(--vsdaw-button-fg)" : "inherit",
                  cursor: insert ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 8,
                  fontWeight: 600,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  padding: "0 2px",
                  opacity: insert && !insert.enabled ? 0.5 : 1,
                }}
              >
                {insert ? insert.name : <Plus size={10} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

function gainToDb(gain: number): number {
  if (gain <= 0.00001) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

const StripButton: React.FC<{
  ariaLabel: string;
  active: boolean;
  onClick: () => void;
  color: string;
  children: React.ReactNode;
}> = ({ ariaLabel, active, onClick, color, children }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-pressed={active}
    onClick={onClick}
    style={{
      width: 18,
      height: 18,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      border: "1px solid var(--vsdaw-border)",
      borderRadius: 2,
      backgroundColor: active ? color : "transparent",
      color: active ? "var(--vsdaw-button-fg)" : "inherit",
      cursor: "pointer",
      fontSize: 9,
      fontWeight: 700,
    }}
  >
    {children}
  </button>
);
