import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Download,
  FileAudio,
  FileMusic,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Redo2,
  Save,
  Settings,
  Undo2,
  Upload,
} from "lucide-react";
import * as React from "react";
import type { TimePosition, TimeSignature, ViewName } from "../../views/shared/types.js";
import { TimeDisplay } from "../transport/TimeDisplay.js";
import { TransportControls } from "../transport/TransportControls.js";
import { ViewSwitcher } from "./ViewSwitcher.js";

export interface ToolbarProps {
  view: string;
  projectName?: string;
  saved?: boolean;
  isPlaying: boolean;
  isRecording: boolean;
  isLooping: boolean;
  isMetronomeEnabled: boolean;
  position: TimePosition;
  bpm: number;
  timeSignature: TimeSignature;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onRecord: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onSetTempo: (bpm: number) => void;
  onSetTimeSignature: (timeSignature: TimeSignature) => void;
  onShowView: (view: ViewName) => void;
  onAddTrack?: (trackType: "audio" | "midi" | "bus") => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onImportAudio?: () => void;
  onImportMidi?: () => void;
  zoom?: number;
  snapDivision?: string;
  onZoomChange?: (zoom: number) => void;
  onSnapChange?: (snap: string) => void;
  onSettings: () => void;
  onExport: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  view,
  projectName,
  saved = true,
  isPlaying,
  isRecording,
  isLooping,
  isMetronomeEnabled,
  position,
  bpm,
  timeSignature,
  onPlay,
  onPause,
  onStop,
  onRecord,
  onToggleLoop,
  onToggleMetronome,
  onSetTempo,
  onSetTimeSignature,
  onShowView,
  onAddTrack,
  onUndo,
  onRedo,
  onImportAudio,
  onImportMidi,
  zoom,
  snapDivision,
  onZoomChange,
  onSnapChange,
  onSettings,
  onExport,
}) => {
  const [showOverflow, setShowOverflow] = React.useState(false);
  const overflowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!showOverflow) return;
    const handleClick = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showOverflow]);

  return (
    <div
      role="toolbar"
      aria-label={`${view} toolbar`}
      className="flex items-center gap-3 px-3 py-2 select-none"
      style={{
        borderBottom: "1px solid var(--vsdaw-border)",
        backgroundColor: "var(--vsdaw-panel-bg)",
      }}
    >
      {/* Left: project info, add track, view switcher */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 min-w-[120px]">
          <span className="font-semibold whitespace-nowrap text-sm truncate">
            {projectName || "Untitled"}
          </span>
          <Save
            size={12}
            style={{ opacity: saved ? 0.3 : 1, color: saved ? "inherit" : "var(--vsdaw-warning)" }}
            aria-label={saved ? "Saved" : "Unsaved changes"}
          />
        </div>

        {onAddTrack && <AddTrackButton onAddTrack={onAddTrack} />}

        {(onImportAudio || onImportMidi) && (
          <ImportButton onImportAudio={onImportAudio} onImportMidi={onImportMidi} />
        )}

        <ViewSwitcher active={view.toLowerCase() as ViewName} onChange={onShowView} />
      </div>

      {/* Center: transport */}
      <div className="flex-1 flex justify-center">
        <TransportControls
          isPlaying={isPlaying}
          isRecording={isRecording}
          isLooping={isLooping}
          isMetronomeEnabled={isMetronomeEnabled}
          onPlay={onPlay}
          onPause={onPause}
          onStop={onStop}
          onRecord={onRecord}
          onToggleLoop={onToggleLoop}
          onToggleMetronome={onToggleMetronome}
        />
      </div>

      {/* Zoom / snap controls */}
      {onZoomChange && zoom != null && (
        <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ backgroundColor: "var(--vsdaw-bg)", border: "1px solid var(--vsdaw-border)" }}>
          <span className="text-xs opacity-70">Zoom</span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.25}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            className="w-24"
            aria-label="Zoom"
          />
          <span className="text-xs opacity-70 w-8 text-right">{Math.round(zoom * 100)}%</span>
        </div>
      )}

      {onSnapChange && snapDivision && (
        <select
          value={snapDivision}
          onChange={(e) => onSnapChange(e.target.value)}
          className="text-xs px-2 py-1 rounded border"
          style={{ backgroundColor: "var(--vsdaw-bg)", borderColor: "var(--vsdaw-border)", color: "inherit" }}
          aria-label="Snap to grid"
        >
          <option value="bar">Bar</option>
          <option value="beat">Beat</option>
          <option value="1/2">1/2</option>
          <option value="1/4">1/4</option>
          <option value="1/8">1/8</option>
          <option value="1/16">1/16</option>
          <option value="none">Off</option>
        </select>
      )}

      {/* Right: time/tempo, overflow */}
      <div className="flex items-center gap-3 ml-auto">
        <TimeDisplay
          position={position}
          bpm={bpm}
          timeSignature={timeSignature}
          onSetTempo={onSetTempo}
          onSetTimeSignature={onSetTimeSignature}
        />

        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            aria-label="Overflow menu"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            onClick={() => setShowOverflow((s) => !s)}
            style={iconButtonStyle}
          >
            <MoreHorizontal size={16} />
          </button>
          {showOverflow && (
            <div
              role="menu"
              className="absolute top-full right-0 mt-1 min-w-[180px] rounded z-50"
              style={{
                backgroundColor: "var(--vsdaw-panel-bg)",
                border: "1px solid var(--vsdaw-border)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              }}
            >
              {onUndo && (
                <OverflowItem
                  icon={<Undo2 size={14} />}
                  label="Undo"
                  onClick={() => {
                    setShowOverflow(false);
                    onUndo();
                  }}
                />
              )}
              {onRedo && (
                <OverflowItem
                  icon={<Redo2 size={14} />}
                  label="Redo"
                  onClick={() => {
                    setShowOverflow(false);
                    onRedo();
                  }}
                />
              )}
              <div className="my-1" style={{ height: 1, backgroundColor: "var(--vsdaw-border)" }} />
              {onImportAudio && (
                <OverflowItem
                  icon={<FileAudio size={14} />}
                  label="Import Audio"
                  onClick={() => {
                    setShowOverflow(false);
                    onImportAudio();
                  }}
                />
              )}
              {onImportMidi && (
                <OverflowItem
                  icon={<FileMusic size={14} />}
                  label="Import MIDI"
                  onClick={() => {
                    setShowOverflow(false);
                    onImportMidi();
                  }}
                />
              )}
              <div className="my-1" style={{ height: 1, backgroundColor: "var(--vsdaw-border)" }} />
              <OverflowItem
                icon={<LayoutGrid size={14} />}
                label="Show timeline"
                onClick={() => {
                  setShowOverflow(false);
                  onShowView("timeline");
                }}
              />
              <OverflowItem
                icon={<Settings size={14} />}
                label="Settings"
                onClick={() => {
                  setShowOverflow(false);
                  onSettings();
                }}
              />
              <OverflowItem
                icon={<Download size={14} />}
                label="Export"
                onClick={() => {
                  setShowOverflow(false);
                  onExport();
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ImportButton: React.FC<{
  onImportAudio?: () => void;
  onImportMidi?: () => void;
}> = ({ onImportAudio, onImportMidi }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Import"
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded cursor-pointer"
          style={{
            border: "1px solid var(--vsdaw-border)",
            backgroundColor: "var(--vsdaw-button-bg)",
            color: "var(--vsdaw-button-fg)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-bg)";
          }}
        >
          <Upload size={14} />
          Import
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="rounded z-50 min-w-[160px]"
          style={{
            backgroundColor: "var(--vsdaw-panel-bg)",
            border: "1px solid var(--vsdaw-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          }}
        >
          {onImportAudio && (
            <DropdownMenu.Item
              className="px-3 py-2 text-xs cursor-pointer outline-none"
              style={{ color: "inherit" }}
              onSelect={() => onImportAudio()}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <span className="inline-flex items-center gap-2">
                <FileAudio size={14} />
                Audio
              </span>
            </DropdownMenu.Item>
          )}
          {onImportMidi && (
            <DropdownMenu.Item
              className="px-3 py-2 text-xs cursor-pointer outline-none"
              style={{ color: "inherit" }}
              onSelect={() => onImportMidi()}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <span className="inline-flex items-center gap-2">
                <FileMusic size={14} />
                MIDI
              </span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

const AddTrackButton: React.FC<{ onAddTrack: (trackType: "audio" | "midi" | "bus") => void }> = ({
  onAddTrack,
}) => {
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Add track"
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded cursor-pointer"
          style={{
            border: "1px solid var(--vsdaw-border)",
            backgroundColor: "var(--vsdaw-button-bg)",
            color: "var(--vsdaw-button-fg)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-bg)";
          }}
        >
          <Plus size={14} />
          Add Track
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="rounded z-50 min-w-[160px]"
          style={{
            backgroundColor: "var(--vsdaw-panel-bg)",
            border: "1px solid var(--vsdaw-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          }}
        >
          <DropdownMenu.Item
            className="px-3 py-2 text-xs cursor-pointer outline-none"
            style={{ color: "inherit" }}
            onSelect={() => onAddTrack("audio")}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            Audio Track
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="px-3 py-2 text-xs cursor-pointer outline-none"
            style={{ color: "inherit" }}
            onSelect={() => onAddTrack("midi")}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            MIDI Track
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="px-3 py-2 text-xs cursor-pointer outline-none"
            style={{ color: "inherit" }}
            onSelect={() => onAddTrack("bus")}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            Bus Track
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

const OverflowItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}> = ({ icon, label, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left bg-transparent border-0 text-inherit cursor-pointer"
    style={{ color: "inherit" }}
    onMouseEnter={(e) => {
      e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.backgroundColor = "transparent";
    }}
  >
    {icon}
    {label}
  </button>
);

export const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  border: "1px solid transparent",
  borderRadius: 4,
  backgroundColor: "transparent",
  color: "inherit",
  cursor: "pointer",
};
