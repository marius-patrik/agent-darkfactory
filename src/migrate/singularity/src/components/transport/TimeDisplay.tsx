import * as React from "react";
import type { TimePosition, TimeSignature } from "../../views/shared/types.js";

export interface TimeDisplayProps {
  position: TimePosition;
  bpm: number;
  timeSignature: TimeSignature;
  onSetTempo: (bpm: number) => void;
  onSetTimeSignature: (timeSignature: TimeSignature) => void;
}

function formatPosition(pos: TimePosition): string {
  const bars = String(pos.bars).padStart(3, "0");
  const beats = String(pos.beats).padStart(2, "0");
  const ticks = String(pos.ticks).padStart(3, "0");
  return `${bars}:${beats}:${ticks}`;
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

function clampBpm(value: number): number {
  return Math.max(1, Math.min(999, Number.isFinite(value) ? value : 120));
}

function parseTimeSignature(text: string): TimeSignature | null {
  const parts = text.split("/").map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length !== 2) return null;
  const [num, den] = parts;
  if (!num || !den || num < 1 || num > 64 || den < 1 || (den & (den - 1)) !== 0) return null;
  return { numerator: num, denominator: den };
}

export const TimeDisplay: React.FC<TimeDisplayProps> = ({
  position,
  bpm,
  timeSignature,
  onSetTempo,
  onSetTimeSignature,
}) => {
  const [editingTempo, setEditingTempo] = React.useState(false);
  const [tempoValue, setTempoValue] = React.useState(String(bpm));

  React.useEffect(() => {
    setTempoValue(String(bpm));
  }, [bpm]);

  const commitTempo = () => {
    const value = Number.parseFloat(tempoValue);
    if (!Number.isNaN(value)) onSetTempo(clampBpm(value));
    setEditingTempo(false);
  };

  return (
    <fieldset
      aria-label="Time display"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontVariantNumeric: "tabular-nums",
        border: 0,
        margin: 0,
        padding: 0,
      }}
    >
      <div
        style={{
          padding: "2px 8px",
          border: "1px solid var(--vsdaw-border)",
          borderRadius: 4,
          backgroundColor: "var(--vsdaw-input-bg)",
          minWidth: 90,
          textAlign: "center",
        }}
        aria-live="polite"
      >
        {formatPosition(position)}
      </div>
      <div
        style={{
          padding: "2px 8px",
          border: "1px solid var(--vsdaw-border)",
          borderRadius: 4,
          backgroundColor: "var(--vsdaw-input-bg)",
          minWidth: 110,
          textAlign: "center",
        }}
      >
        {formatSeconds(position.seconds)}
      </div>
      {editingTempo ? (
        <input
          aria-label="Tempo"
          type="number"
          value={tempoValue}
          min={1}
          max={999}
          onChange={(e) => setTempoValue(e.target.value)}
          onBlur={commitTempo}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTempo();
            else if (e.key === "Escape") setEditingTempo(false);
          }}
          style={{
            width: 50,
            padding: "2px 4px",
            border: "1px solid var(--vsdaw-input-border)",
            borderRadius: 4,
            backgroundColor: "var(--vsdaw-input-bg)",
            color: "inherit",
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={`Tempo ${bpm} BPM`}
          onClick={() => setEditingTempo(true)}
          style={{
            padding: "2px 8px",
            border: "1px solid var(--vsdaw-border)",
            borderRadius: 4,
            backgroundColor: "var(--vsdaw-input-bg)",
            cursor: "pointer",
            minWidth: 50,
          }}
        >
          {bpm}
        </button>
      )}
      <TimeSignatureEditor value={timeSignature} onChange={onSetTimeSignature} />
    </fieldset>
  );
};

const TimeSignatureEditor: React.FC<{
  value: TimeSignature;
  onChange: (value: TimeSignature) => void;
}> = ({ value, onChange }) => {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(`${value.numerator}/${value.denominator}`);

  React.useEffect(() => {
    setText(`${value.numerator}/${value.denominator}`);
  }, [value]);

  const commit = () => {
    const parsed = parseTimeSignature(text);
    if (parsed) onChange(parsed);
    setEditing(false);
  };

  return editing ? (
    <input
      aria-label="Time signature"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: 50,
        padding: "2px 4px",
        border: "1px solid var(--vsdaw-input-border)",
        borderRadius: 4,
        backgroundColor: "var(--vsdaw-input-bg)",
        color: "inherit",
      }}
    />
  ) : (
    <button
      type="button"
      aria-label={`Time signature ${value.numerator}/${value.denominator}`}
      onClick={() => setEditing(true)}
      style={{
        padding: "2px 8px",
        border: "1px solid var(--vsdaw-border)",
        borderRadius: 4,
        backgroundColor: "var(--vsdaw-input-bg)",
        cursor: "pointer",
        minWidth: 42,
      }}
    >
      {value.numerator}/{value.denominator}
    </button>
  );
};
