import { motion } from "framer-motion";
import { Circle, Music2, Pause, Play, Repeat, Square } from "lucide-react";
import type * as React from "react";
import { iconButtonStyle } from "../shared/Toolbar.js";
import { Tooltip, TooltipProvider } from "../shared/Tooltip.js";

export interface TransportControlsProps {
  isPlaying: boolean;
  isRecording: boolean;
  isLooping: boolean;
  isMetronomeEnabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onRecord: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
}

export const TransportControls: React.FC<TransportControlsProps> = ({
  isPlaying,
  isRecording,
  isLooping,
  isMetronomeEnabled,
  onPlay,
  onPause,
  onStop,
  onRecord,
  onToggleLoop,
  onToggleMetronome,
}) => {
  return (
    <TooltipProvider>
      <div
        role="group"
        aria-label="Transport controls"
        className="flex items-center gap-1.5 px-2 py-1 rounded"
        style={{ backgroundColor: "var(--vsdaw-bg)", border: "1px solid var(--vsdaw-border)" }}
      >
        <Tooltip content={isPlaying ? "Pause (Space)" : "Play (Space)"}>
          <TransportButton
            ariaLabel={isPlaying ? "Pause" : "Play"}
            active={isPlaying}
            onClick={isPlaying ? onPause : onPlay}
            accent={isPlaying}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </TransportButton>
        </Tooltip>

        <Tooltip content="Stop (Cmd/Ctrl+1)">
          <TransportButton ariaLabel="Stop" onClick={onStop}>
            <Square size={16} />
          </TransportButton>
        </Tooltip>

        <Tooltip content="Record (Cmd/Ctrl+R)">
          <TransportButton
            ariaLabel="Record"
            active={isRecording}
            onClick={onRecord}
            accent={isRecording}
            accentColor="var(--vsdaw-error)"
          >
            <Circle size={16} fill={isRecording ? "currentColor" : "none"} />
          </TransportButton>
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ backgroundColor: "var(--vsdaw-border)" }} />

        <Tooltip content="Toggle loop (Cmd/Ctrl+L)">
          <TransportButton
            ariaLabel="Toggle loop"
            active={isLooping}
            onClick={onToggleLoop}
            accent={isLooping}
          >
            <Repeat size={16} />
          </TransportButton>
        </Tooltip>

        <Tooltip content="Toggle metronome">
          <TransportButton
            ariaLabel="Toggle metronome"
            active={isMetronomeEnabled}
            onClick={onToggleMetronome}
            accent={isMetronomeEnabled}
          >
            <Music2 size={16} />
          </TransportButton>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
};

const TransportButton: React.FC<{
  ariaLabel: string;
  active?: boolean;
  accent?: boolean;
  accentColor?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ ariaLabel, active, accent, accentColor, onClick, children }) => {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.04 }}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      style={{
        ...iconButtonStyle,
        width: 32,
        height: 32,
        color: accent ? accentColor || "var(--vsdaw-button-fg)" : "inherit",
        backgroundColor: accent ? accentColor || "var(--vsdaw-button-bg)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!accent) e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
      }}
      onMouseLeave={(e) => {
        if (!accent) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {children}
    </motion.button>
  );
};
