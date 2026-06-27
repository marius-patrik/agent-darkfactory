import * as React from "react";
import type { NoteState } from "../../views/shared/types.js";

const KEY_HEIGHT = 16;
const BEAT_WIDTH = 80;
const PITCH_MIN = 24;
const PITCH_MAX = 108;
const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;
const VISIBLE_BEATS = 16;

export interface PianoRollGridProps {
  notes: NoteState[];
  snap: "off" | "1/4" | "1/2" | "beat" | "bar";
  onAddNote: (note: { start: number; duration: number; pitch: number; velocity: number }) => void;
  onMoveNote: (noteId: string, start: number, pitch: number) => void;
  onResizeNote: (noteId: string, duration: number) => void;
  onDeleteNote: (noteId: string) => void;
}

export const PianoRollGrid: React.FC<PianoRollGridProps> = ({
  notes,
  snap,
  onAddNote,
  onMoveNote,
  onResizeNote,
  onDeleteNote,
}) => {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [drag, setDrag] = React.useState<
    | { type: "move"; noteId: string; startOffset: number; pitchOffset: number }
    | { type: "resize"; noteId: string; startDuration: number; startX: number }
    | null
  >(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const totalWidth = VISIBLE_BEATS * BEAT_WIDTH;
  const totalHeight = PITCH_COUNT * KEY_HEIGHT;

  const xToBeats = (x: number) => x / BEAT_WIDTH;
  const yToPitch = (y: number) => PITCH_MAX - Math.floor(y / KEY_HEIGHT);

  const snapBeats = (beats: number): number => {
    if (snap === "off") return beats;
    const grid = snap === "bar" ? 4 : snap === "beat" ? 1 : snap === "1/2" ? 0.5 : 0.25;
    return Math.round(beats / grid) * grid;
  };

  const toSvgPoint = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM()?.inverse());
  };

  const handleBackgroundClick = (e: React.MouseEvent<SVGRectElement>) => {
    if (drag) return;
    const cursor = toSvgPoint(e);
    const start = snapBeats(xToBeats(cursor.x - 60));
    const pitch = yToPitch(cursor.y);
    if (pitch >= PITCH_MIN && pitch <= PITCH_MAX) {
      onAddNote({ start, duration: 0.5, pitch, velocity: 100 });
    }
  };

  const handleNoteMouseDown = (e: React.MouseEvent, note: NoteState, action: "move" | "resize") => {
    e.stopPropagation();
    setSelectedId(note.id);
    const cursor = toSvgPoint(e);

    if (action === "move") {
      setDrag({
        type: "move",
        noteId: note.id,
        startOffset: cursor.x / BEAT_WIDTH - note.start,
        pitchOffset: note.pitch - yToPitch(cursor.y),
      });
    } else {
      setDrag({
        type: "resize",
        noteId: note.id,
        startDuration: note.duration,
        startX: cursor.x,
      });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const cursor = toSvgPoint(e);

    if (drag.type === "move") {
      const rawStart = xToBeats(cursor.x) - drag.startOffset;
      const start = snapBeats(rawStart);
      const pitch = yToPitch(cursor.y) + drag.pitchOffset;
      onMoveNote(drag.noteId, start, Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch)));
    } else if (drag.type === "resize") {
      const delta = (cursor.x - drag.startX) / BEAT_WIDTH;
      const duration = snapBeats(Math.max(0.1, drag.startDuration + delta));
      onResizeNote(drag.noteId, duration);
    }
  };

  const handleMouseUp = () => setDrag(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      const target = document.activeElement;
      const noteId = target?.getAttribute("data-note-id") ?? selectedId;
      if (noteId) {
        e.preventDefault();
        onDeleteNote(noteId);
        setSelectedId(null);
      }
    }
  };

  const blackKeyIndices = React.useMemo(() => new Set([1, 3, 6, 8, 10]), []);

  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label="Piano roll grid"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onKeyDown={handleKeyDown}
      viewBox={`0 0 ${totalWidth + 60} ${totalHeight}`}
      style={{
        width: "100%",
        height: "100%",
        minWidth: totalWidth + 60,
        cursor: drag ? (drag.type === "resize" ? "e-resize" : "grabbing") : "default",
      }}
    >
      {/* Background grid */}
      <rect
        x={60}
        y={0}
        width={totalWidth}
        height={totalHeight}
        fill="var(--vsdaw-bg)"
        onClick={handleBackgroundClick}
      />
      {Array.from({ length: PITCH_COUNT + 1 }).map((_, i) => {
        const y = i * KEY_HEIGHT;
        const pitch = PITCH_MAX - i;
        const isBlack = blackKeyIndices.has(pitch % 12);
        return (
          <g key={`row-${pitch}`}>
            <rect
              x={0}
              y={y}
              width={60}
              height={KEY_HEIGHT}
              fill={isBlack ? "var(--vsdaw-input-bg)" : "var(--vsdaw-panel-bg)"}
              opacity={isBlack ? 0.6 : 0.3}
            />
            <line
              x1={0}
              y1={y}
              x2={totalWidth + 60}
              y2={y}
              stroke="var(--vsdaw-border)"
              strokeWidth={0.5}
            />
            {pitch % 12 === 0 && (
              <text x={4} y={y + KEY_HEIGHT / 2} fontSize={9} fill="var(--vsdaw-fg)">
                {pitch}
              </text>
            )}
          </g>
        );
      })}
      {Array.from({ length: VISIBLE_BEATS * 4 + 1 }).map((_, i) => {
        const x = 60 + (i / 4) * BEAT_WIDTH;
        return (
          <line
            key={`grid-${x}`}
            x1={x}
            y1={0}
            x2={x}
            y2={totalHeight}
            stroke="var(--vsdaw-border)"
            strokeWidth={i % 4 === 0 ? 1 : 0.5}
            opacity={i % 4 === 0 ? 0.6 : 0.3}
          />
        );
      })}

      {/* Notes */}
      {notes.map((note) => {
        const y = (PITCH_MAX - note.pitch) * KEY_HEIGHT;
        const x = 60 + note.start * BEAT_WIDTH;
        const w = Math.max(2, note.duration * BEAT_WIDTH);
        const isSelected = selectedId === note.id;
        return (
          <g key={note.id}>
            <rect
              data-note-id={note.id}
              tabIndex={0}
              aria-label={`Note ${note.pitch} at ${note.start.toFixed(2)}`}
              x={x}
              y={y + 1}
              width={w - 1}
              height={KEY_HEIGHT - 2}
              rx={2}
              fill="var(--vsdaw-button-bg)"
              stroke={isSelected ? "var(--vsdaw-button-fg)" : "var(--vsdaw-focus)"}
              strokeWidth={isSelected ? 2 : 0.5}
              onMouseDown={(e) => handleNoteMouseDown(e, note, "move")}
              onDoubleClick={() => onDeleteNote(note.id)}
              onFocus={() => setSelectedId(note.id)}
            />
            <rect
              x={x + w - 6}
              y={y + 1}
              width={5}
              height={KEY_HEIGHT - 2}
              fill="transparent"
              cursor="e-resize"
              onMouseDown={(e) => handleNoteMouseDown(e, note, "resize")}
            />
          </g>
        );
      })}

      {notes.length === 0 && (
        <text
          x={(totalWidth + 60) / 2}
          y={totalHeight / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={12}
          fill="var(--vsdaw-fg)"
          opacity={0.5}
          pointerEvents="none"
        >
          Click on the grid to add notes
        </text>
      )}
    </svg>
  );
};
