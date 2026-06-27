import * as React from "react";
import { createRoot } from "react-dom/client";
import { PianoRollGrid } from "../../components/pianoRoll/PianoRollGrid.js";
import { VelocityLane } from "../../components/pianoRoll/VelocityLane.js";
import { ErrorBoundary } from "../../components/shared/ErrorBoundary.js";
import { PanelShell } from "../../components/shared/PanelShell.js";
import { ThemeProvider } from "../../components/shared/ThemeProvider.js";
import { Toolbar } from "../../components/shared/Toolbar.js";
import { useViewState } from "../shared/useViewState.js";

const PianoRollView: React.FC = () => {
  const state = useViewState("pianoRoll");
  const [snap, setSnap] = React.useState<Parameters<typeof PianoRollGrid>[0]["snap"]>("beat");

  const regionId = state.selection.regionId;
  const notes = React.useMemo(
    () => (regionId ? state.notes.filter((n) => n.regionId === regionId) : state.notes),
    [state.notes, regionId],
  );

  const addNote = (note: { start: number; duration: number; pitch: number; velocity: number }) => {
    if (!regionId) return;
    state.pianoRollActions.createNote(regionId, note.start, note.duration, note.pitch, note.velocity);
  };

  const moveNote = (noteId: string, start: number, pitch: number) => {
    state.pianoRollActions.moveNote(noteId, start, pitch);
  };

  const resizeNote = (noteId: string, duration: number) => {
    state.pianoRollActions.resizeNote(noteId, duration);
  };

  const setVelocity = (noteId: string, velocity: number) => {
    state.pianoRollActions.setNoteVelocity(noteId, velocity);
  };

  const deleteNote = (noteId: string) => {
    state.pianoRollActions.deleteNote(noteId);
  };

  return (
    <ErrorBoundary viewName="Piano Roll">
      <ThemeProvider>
        <PanelShell>
          <Toolbar
            view="Piano Roll"
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 8px",
              borderBottom: "1px solid var(--vsdaw-border)",
            }}
          >
            <label htmlFor="snap-select" style={{ fontSize: 11 }}>
              Snap
            </label>
            <select
              id="snap-select"
              aria-label="Snap mode"
              value={snap}
              onChange={(e) => setSnap(e.target.value as typeof snap)}
              style={{
                backgroundColor: "var(--vsdaw-input-bg)",
                color: "inherit",
                border: "1px solid var(--vsdaw-input-border)",
                borderRadius: 4,
                padding: "2px 6px",
              }}
            >
              <option value="off">Off</option>
              <option value="1/4">1/4 beat</option>
              <option value="1/2">1/2 beat</option>
              <option value="beat">Beat</option>
              <option value="bar">Bar</option>
            </select>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
            <div style={{ flex: 1, overflow: "auto" }}>
              <PianoRollGrid
                notes={notes}
                snap={snap}
                onAddNote={addNote}
                onMoveNote={moveNote}
                onResizeNote={resizeNote}
                onDeleteNote={deleteNote}
              />
            </div>
            <VelocityLane notes={notes} onSetVelocity={setVelocity} />
          </div>
        </PanelShell>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<PianoRollView />);
