import * as React from "react";
import { createRoot } from "react-dom/client";
import { type GraphEdge, type GraphNode, GraphView } from "../../components/graph/GraphView.js";
import { ErrorBoundary } from "../../components/shared/ErrorBoundary.js";
import { PanelShell } from "../../components/shared/PanelShell.js";
import { ThemeProvider } from "../../components/shared/ThemeProvider.js";
import { Toolbar } from "../../components/shared/Toolbar.js";
import { useViewState } from "../shared/useViewState.js";

const defaultNodes: GraphNode[] = [
  { id: "in", type: "input", label: "Audio Input", x: 40, y: 120 },
  { id: "t1", type: "track", label: "Track 1", x: 220, y: 80 },
  { id: "t2", type: "track", label: "Track 2", x: 220, y: 180 },
  { id: "out", type: "output", label: "Master Out", x: 460, y: 130 },
];

const defaultEdges: GraphEdge[] = [
  { from: "in", to: "t1" },
  { from: "t1", to: "out" },
  { from: "t2", to: "out" },
];

const GraphPage: React.FC = () => {
  const state = useViewState("graph");
  const [nodes, setNodes] = React.useState<GraphNode[]>(defaultNodes);
  const [edges, setEdges] = React.useState<GraphEdge[]>(defaultEdges);

  const onNodeMove = (id: string, x: number, y: number) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
  };

  const onConnect = (from: string, to: string) => {
    setEdges((prev) => {
      if (prev.some((e) => e.from === from && e.to === to)) return prev;
      return [...prev, { from, to }];
    });
  };

  return (
    <ErrorBoundary viewName="Graph">
      <ThemeProvider>
        <PanelShell>
          <Toolbar
            view="Graph"
            projectName={state.projectName}
            saved={state.saved}
            isPlaying={state.isPlaying}
            isRecording={state.isRecording}
            isLooping={state.isLooping}
            isMetronomeEnabled={state.isMetronomeEnabled}
            position={state.position}
            bpm={state.bpm}
            timeSignature={state.timeSignature}
            onPlay={state.transport.play}
            onPause={state.transport.pause}
            onStop={state.transport.stop}
            onRecord={state.transport.record}
            onToggleLoop={state.transport.toggleLoop}
            onToggleMetronome={state.transport.toggleMetronome}
            onSetTempo={state.transport.setTempo}
            onSetTimeSignature={state.transport.setTimeSignature}
            onShowView={state.commands.showView}
            onSettings={() => state.commands.showView("browser")}
            onExport={state.commands.export}
          />
          <GraphView nodes={nodes} edges={edges} onNodeMove={onNodeMove} onConnect={onConnect} />
        </PanelShell>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<GraphPage />);
