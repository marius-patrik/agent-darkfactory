import * as React from "react";
import { createRoot } from "react-dom/client";
import { EmptyState } from "../../components/shared/EmptyState.js";
import { ErrorBoundary } from "../../components/shared/ErrorBoundary.js";
import { PanelShell } from "../../components/shared/PanelShell.js";
import { ThemeProvider } from "../../components/shared/ThemeProvider.js";
import { Toolbar } from "../../components/shared/Toolbar.js";
import { TimelineCanvas } from "../../components/timeline/TimelineCanvas.js";
import { TrackColumnHeader } from "../../components/timeline/TrackColumnHeader.js";
import { TrackHeader } from "../../components/timeline/TrackHeader.js";
import type { TrackState } from "../shared/types.js";
import { useViewState } from "../shared/useViewState.js";

const TimelineView: React.FC = () => {
  const state = useViewState("timeline");
  const headerScrollRef = React.useRef<HTMLDivElement>(null);
  const canvasWrapperRef = React.useRef<HTMLDivElement>(null);
  const isSyncing = React.useRef(false);

  const positionBeats = React.useMemo(() => {
    const numerator = state.timeSignature.numerator || 4;
    return (
      (state.position.bars - 1) * numerator +
      (state.position.beats - 1) +
      state.position.ticks / 960
    );
  }, [state.position, state.timeSignature.numerator]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          state.isPlaying ? state.transport.pause() : state.transport.play();
          break;
        case "Delete":
        case "Backspace":
          state.commands.delete();
          break;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        state.commands.duplicate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    state.isPlaying,
    state.transport.play,
    state.transport.pause,
    state.commands.delete,
    state.commands.duplicate,
  ]);

  const syncScroll = React.useCallback((source: "header" | "canvas") => {
    if (isSyncing.current) return;
    const header = headerScrollRef.current;
    const canvas = canvasWrapperRef.current?.firstElementChild as HTMLElement | null;
    if (!header || !canvas) return;

    isSyncing.current = true;
    if (source === "header") {
      if (canvas.scrollTop !== header.scrollTop) {
        canvas.scrollTop = header.scrollTop;
      }
    } else {
      if (header.scrollTop !== canvas.scrollTop) {
        header.scrollTop = canvas.scrollTop;
      }
    }
    isSyncing.current = false;
  }, []);

  React.useEffect(() => {
    const canvas = canvasWrapperRef.current?.firstElementChild as HTMLElement | null;
    if (!canvas) return;

    const handler = () => syncScroll("canvas");
    canvas.addEventListener("scroll", handler, { passive: true });
    return () => canvas.removeEventListener("scroll", handler);
  }, [syncScroll]);

  const hasTracks = state.tracks.length > 0;

  return (
    <ErrorBoundary viewName="Timeline">
      <ThemeProvider>
        <PanelShell>
          <Toolbar
            view="Timeline"
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
            onAddTrack={state.trackActions.createTrack}
            onSettings={() => state.commands.showView("browser")}
            onExport={state.commands.export}
          />
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            <div
              ref={headerScrollRef}
              role="region"
              aria-label="Track headers"
              onScroll={() => syncScroll("header")}
              style={{ overflowY: "auto", flexShrink: 0 }}
            >
              <TrackColumnHeader
                trackCount={state.tracks.length}
                onAddTrack={state.trackActions.createTrack}
              />
              {state.tracks.map((track: TrackState) => (
                <TrackHeader
                  key={track.id}
                  track={track}
                  onMute={() => state.trackActions.setMute(track.id, !track.muted)}
                  onSolo={() => state.trackActions.setSolo(track.id, !track.soloed)}
                  onArm={() => state.trackActions.setArm(track.id, !track.armed)}
                  onVolume={(v: number) => state.trackActions.setVolume(track.id, v)}
                  onPan={(p: number) => state.trackActions.setPan(track.id, p)}
                  onName={(n: string) => state.trackActions.setName(track.id, n)}
                  onDelete={() => state.trackActions.deleteTrack(track.id)}
                  onSetColor={(color: string) => state.trackActions.setColor(track.id, color)}
                  onAddInsert={(deviceName: string) =>
                    state.trackActions.addInsert(track.id, deviceName)
                  }
                />
              ))}
            </div>
            <div ref={canvasWrapperRef} style={{ flex: 1, overflow: "hidden" }}>
              {hasTracks ? (
                <TimelineCanvas
                  tracks={state.tracks}
                  positionBeats={positionBeats}
                  loopStart={0}
                  loopEnd={16}
                  timeSignatureNumerator={state.timeSignature.numerator}
                  onSeek={state.transport.seek}
                  onSelectRegion={state.timelineActions.selectRegion}
                  onMoveRegion={state.timelineActions.moveRegion}
                />
              ) : (
                <EmptyState
                  title="No tracks yet"
                  subtitle="Add a track in the timeline to start arranging regions."
                />
              )}
            </div>
          </div>
        </PanelShell>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<TimelineView />);
