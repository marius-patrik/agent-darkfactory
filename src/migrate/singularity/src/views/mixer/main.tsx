import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DevicePanel } from "../../components/device/DevicePanel.js";
import { MixerStrip } from "../../components/mixer/MixerStrip.js";
import { EmptyState } from "../../components/shared/EmptyState.js";
import { ErrorBoundary } from "../../components/shared/ErrorBoundary.js";
import { PanelShell } from "../../components/shared/PanelShell.js";
import { ThemeProvider } from "../../components/shared/ThemeProvider.js";
import { Toolbar } from "../../components/shared/Toolbar.js";
import type { TrackState } from "../shared/types.js";
import { useViewState } from "../shared/useViewState.js";

const masterTrack = (tracks: TrackState[], themeColor: string): TrackState => ({
  id: "master",
  name: "Master",
  color: themeColor,
  muted: false,
  soloed: false,
  armed: false,
  volume: 0.8,
  pan: 0,
  height: 0,
  inserts: [],
  regions: [],
  automationLanes: [],
  sends: [],
});

const MixerView: React.FC = () => {
  const state = useViewState("mixer");
  const [accentColor, setAccentColor] = useState("#cccccc");
  const [selectedInsert, setSelectedInsert] = useState<{
    trackId: string;
    insertId: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setAccentColor(styles.getPropertyValue("--vsdaw-button-bg").trim() || "#cccccc");
  }, []);

  useEffect(() => {
    if (selectedInsert) {
      state.deviceActions.getParameters(selectedInsert.insertId);
    }
  }, [selectedInsert, state.deviceActions.getParameters]);

  const handleOpenInsert = (trackId: string, slot: number) => {
    const track = state.tracks.find((t) => t.id === trackId);
    const insert = track?.inserts[slot];
    if (!insert) {
      return;
    }
    setSelectedInsert({ trackId, insertId: insert.id, name: insert.name });
  };

  const handleParameterChange = (parameter: string, value: number | boolean) => {
    if (!selectedInsert) {
      return;
    }
    state.deviceActions.setParameter(selectedInsert.insertId, parameter, value);
  };

  const parameters =
    selectedInsert && state.deviceParameters?.deviceId === selectedInsert.insertId
      ? state.deviceParameters.parameters
      : [];

  return (
    <ErrorBoundary viewName="Mixer">
      <ThemeProvider>
        <PanelShell>
          <Toolbar
            view="Mixer"
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
          {state.tracks.length === 0 ? (
            <EmptyState
              title="No mixer channels"
              subtitle="Tracks added to the project will appear here as channel strips."
            />
          ) : (
            <div style={{ position: "relative", flex: 1, display: "flex" }}>
              <fieldset
                aria-label="Mixer channels"
                style={{
                  flex: 1,
                  display: "flex",
                  overflowX: "auto",
                  overflowY: "hidden",
                  border: 0,
                  margin: 0,
                  padding: 0,
                }}
              >
                {state.tracks.map((track: TrackState) => (
                  <MixerStrip
                    key={track.id}
                    track={track}
                    onMute={() => state.trackActions.setMute(track.id, !track.muted)}
                    onSolo={() => state.trackActions.setSolo(track.id, !track.soloed)}
                    onArm={() => state.trackActions.setArm(track.id, !track.armed)}
                    onVolume={(v: number) => state.trackActions.setVolume(track.id, v)}
                    onPan={(p: number) => state.trackActions.setPan(track.id, p)}
                    onOpenInsert={(slot: number) => handleOpenInsert(track.id, slot)}
                  />
                ))}
                <MixerStrip
                  track={masterTrack(state.tracks, accentColor)}
                  isMaster
                  onMute={() => {}}
                  onSolo={() => {}}
                  onArm={() => {}}
                  onVolume={() => {}}
                  onPan={() => {}}
                  onOpenInsert={() => {}}
                />
              </fieldset>
              {selectedInsert && (
                <DevicePanel
                  deviceId={selectedInsert.insertId}
                  deviceName={selectedInsert.name}
                  parameters={parameters}
                  onParameterChange={handleParameterChange}
                  onClose={() => setSelectedInsert(null)}
                />
              )}
            </div>
          )}
        </PanelShell>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<MixerView />);
