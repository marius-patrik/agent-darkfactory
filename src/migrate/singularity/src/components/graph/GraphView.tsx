import * as React from "react";

export interface GraphNode {
  id: string;
  type: "input" | "output" | "track" | "device";
  label: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeMove: (id: string, x: number, y: number) => void;
  onConnect: (from: string, to: string) => void;
}

const NODE_WIDTH = 120;
const NODE_HEIGHT = 48;
const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 600;

export const GraphView: React.FC<GraphViewProps> = ({ nodes, edges, onNodeMove, onConnect }) => {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [drag, setDrag] = React.useState<{ id: string; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [connecting, setConnecting] = React.useState<{ from: string; x: number; y: number } | null>(
    null,
  );

  const toSvgPoint = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM()?.inverse());
  };

  const handleNodeMouseDown = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    const p = toSvgPoint(e);
    setDrag({ id: node.id, offsetX: p.x - node.x, offsetY: p.y - node.y });
  };

  const handleOutputMouseDown = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    const p = toSvgPoint(e);
    setConnecting({ from: node.id, x: p.x, y: p.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (drag) {
      const p = toSvgPoint(e);
      onNodeMove(drag.id, p.x - drag.offsetX, p.y - drag.offsetY);
    } else if (connecting) {
      const p = toSvgPoint(e);
      setConnecting({ ...connecting, x: p.x, y: p.y });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (connecting) {
      const target = (e.target as Element).closest("[data-node-id]");
      if (target) {
        const to = target.getAttribute("data-node-id");
        if (to && to !== connecting.from) onConnect(connecting.from, to);
      }
    }
    setDrag(null);
    setConnecting(null);
  };

  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label="Routing graph"
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      style={{ width: "100%", height: "100%", backgroundColor: "var(--vsdaw-bg)" }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <defs>
        <marker
          id="arrow"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L9,3 z" fill="var(--vsdaw-fg)" />
        </marker>
      </defs>
      {nodes.length === 0 && (
        <text
          x={VIEWBOX_WIDTH / 2}
          y={VIEWBOX_HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={14}
          fill="var(--vsdaw-fg)"
          opacity={0.5}
          pointerEvents="none"
        >
          No routing nodes
        </text>
      )}
      {edges.map((edge) => {
        const from = nodes.find((n) => n.id === edge.from);
        const to = nodes.find((n) => n.id === edge.to);
        if (!from || !to) return null;
        return (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={from.x + NODE_WIDTH}
            y1={from.y + NODE_HEIGHT / 2}
            x2={to.x}
            y2={to.y + NODE_HEIGHT / 2}
            stroke="var(--vsdaw-fg)"
            strokeWidth={1.5}
            markerEnd="url(#arrow)"
            opacity={0.6}
          />
        );
      })}
      {connecting && (
        <line
          x1={nodes.find((n) => n.id === connecting.from)?.x ?? 0 + NODE_WIDTH}
          y1={nodes.find((n) => n.id === connecting.from)?.y ?? 0 + NODE_HEIGHT / 2}
          x2={connecting.x}
          y2={connecting.y}
          stroke="var(--vsdaw-button-bg)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      )}
      {nodes.map((node) => (
        <g
          key={node.id}
          data-node-id={node.id}
          transform={`translate(${node.x}, ${node.y})`}
          onMouseDown={(e) => handleNodeMouseDown(e, node)}
          style={{ cursor: drag?.id === node.id ? "grabbing" : "grab" }}
        >
          <rect
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
            rx={4}
            fill="var(--vsdaw-panel-bg)"
            stroke="var(--vsdaw-border)"
            strokeWidth={1}
          />
          <text
            x={NODE_WIDTH / 2}
            y={NODE_HEIGHT / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill="var(--vsdaw-fg)"
          >
            {node.label}
          </text>
          <circle
            cx={NODE_WIDTH}
            cy={NODE_HEIGHT / 2}
            r={5}
            fill="var(--vsdaw-button-bg)"
            style={{ cursor: "crosshair" }}
            onMouseDown={(e) => handleOutputMouseDown(e, node)}
          />
          <circle cx={0} cy={NODE_HEIGHT / 2} r={5} fill="var(--vsdaw-focus)" />
        </g>
      ))}
    </svg>
  );
};
