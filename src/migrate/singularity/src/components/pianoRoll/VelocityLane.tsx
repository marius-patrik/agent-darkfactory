import * as React from "react";
import type { NoteState } from "../../views/shared/types.js";

const LANE_HEIGHT = 80;
const BEAT_WIDTH = 80;
const VISIBLE_BEATS = 16;

export interface VelocityLaneProps {
  notes: NoteState[];
  onSetVelocity: (noteId: string, velocity: number) => void;
}

export const VelocityLane: React.FC<VelocityLaneProps> = ({ notes, onSetVelocity }) => {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);

  const totalWidth = VISIBLE_BEATS * BEAT_WIDTH;

  const toSvgPoint = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM()?.inverse());
  };

  const updateVelocity = (e: { clientX: number; clientY: number }) => {
    if (!dragId) return;
    const cursor = toSvgPoint(e);
    const velocity = Math.max(0, Math.min(127, Math.round((1 - cursor.y / LANE_HEIGHT) * 127)));
    onSetVelocity(dragId, velocity);
  };

  const handleMouseDown = (e: React.MouseEvent, note: NoteState) => {
    e.stopPropagation();
    setDragId(note.id);
    updateVelocity(e);
  };

  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label="Velocity lane"
      viewBox={`0 0 ${totalWidth + 60} ${LANE_HEIGHT}`}
      style={{
        width: "100%",
        minWidth: totalWidth + 60,
        height: LANE_HEIGHT,
        borderTop: "1px solid var(--vsdaw-border)",
      }}
      onMouseMove={updateVelocity}
      onMouseUp={() => setDragId(null)}
      onMouseLeave={() => setDragId(null)}
    >
      <rect x={60} y={0} width={totalWidth} height={LANE_HEIGHT} fill="var(--vsdaw-bg)" />
      {[32, 64, 96].map((v) => (
        <line
          key={v}
          x1={60}
          y1={LANE_HEIGHT - (v / 127) * LANE_HEIGHT}
          x2={totalWidth + 60}
          y2={LANE_HEIGHT - (v / 127) * LANE_HEIGHT}
          stroke="var(--vsdaw-border)"
          strokeDasharray="2 2"
        />
      ))}
      {notes.length === 0 && (
        <text
          x={(totalWidth + 60) / 2}
          y={LANE_HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={11}
          fill="var(--vsdaw-fg)"
          opacity={0.4}
          pointerEvents="none"
        >
          No notes
        </text>
      )}
      {notes.map((note) => {
        const x = 60 + note.start * BEAT_WIDTH;
        const w = Math.max(4, note.duration * BEAT_WIDTH);
        const h = (note.velocity / 127) * LANE_HEIGHT;
        return (
          <rect
            key={note.id}
            aria-label={`Velocity for note ${note.pitch}`}
            x={x}
            y={LANE_HEIGHT - h}
            width={w - 1}
            height={h}
            fill="var(--vsdaw-button-bg)"
            opacity={0.8}
            cursor="ns-resize"
            onMouseDown={(e) => handleMouseDown(e, note)}
          />
        );
      })}
    </svg>
  );
};
