import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, LayoutGrid, MoreHorizontal, Plus, Save, Settings } from "lucide-react";
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
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            Audio Track
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="px-3 py-2 text-xs cursor-pointer outline-none"
            style={{ color: "inherit" }}
            onSelect={() => onAddTrack("midi")}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            MIDI Track
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="px-3 py-2 text-xs cursor-pointer outline-none"
            style={{ color: "inherit" }}
            onSelect={() => onAddTrack("bus")}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
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
    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
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
