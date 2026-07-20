import { createRoot } from "react-dom/client";
import { BrowserTree } from "../../components/browser/BrowserTree.js";
import { ErrorBoundary } from "../../components/shared/ErrorBoundary.js";
import { PanelShell } from "../../components/shared/PanelShell.js";
import { ThemeProvider } from "../../components/shared/ThemeProvider.js";
import { Toolbar } from "../../components/shared/Toolbar.js";
import type { BrowserNode, DeviceItem } from "../shared/types.js";
import { useViewState } from "../shared/useViewState.js";

const defaultBrowserRoot: BrowserNode = {
  id: "root",
  name: "Browser",
  type: "folder",
  children: [
    {
      id: "devices",
      name: "Devices",
      type: "folder",
      children: [
        { id: "devices-instruments", name: "Instruments", type: "folder", children: [] },
        { id: "devices-audio-effects", name: "Audio Effects", type: "folder", children: [] },
        { id: "devices-midi-effects", name: "MIDI Effects", type: "folder", children: [] },
      ],
    },
    {
      id: "workspace",
      name: "Workspace Samples",
      type: "folder",
      children: [],
    },
    {
      id: "project",
      name: "Project Samples",
      type: "folder",
      children: [],
    },
  ],
};

const BrowserView: React.FC = () => {
  const state = useViewState("browser");
  const root = state.browserRoot ?? defaultBrowserRoot;

  const handleAddToTrack = (device: DeviceItem) => {
    const trackId = state.selection.trackId;
    if (!trackId) {
      return;
    }
    state.trackActions.addInsert(trackId, device.id, device.category);
  };

  return (
    <ErrorBoundary viewName="Browser">
      <ThemeProvider>
        <PanelShell>
          <Toolbar
            view="Browser"
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
          <BrowserTree
            root={root}
            onPreview={state.browserActions.preview}
            onDragStart={state.browserActions.dragStart}
            onAddToTrack={handleAddToTrack}
          />
        </PanelShell>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<BrowserView />);
