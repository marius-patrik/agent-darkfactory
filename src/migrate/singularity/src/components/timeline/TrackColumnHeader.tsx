import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus } from "lucide-react";
import * as React from "react";

export interface TrackColumnHeaderProps {
  trackCount: number;
  onAddTrack: (trackType: "audio" | "midi" | "bus") => void;
}

export const TrackColumnHeader: React.FC<TrackColumnHeaderProps> = ({ trackCount, onAddTrack }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <div
      style={{
        height: 48,
        padding: "0 8px",
        borderRight: "1px solid var(--vsdaw-border)",
        borderBottom: "1px solid var(--vsdaw-border)",
        backgroundColor: "var(--vsdaw-panel-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 12 }}>Tracks ({trackCount})</span>

      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Add track"
            aria-haspopup="menu"
            aria-expanded={open}
            style={{
              height: 28,
              padding: "0 10px",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: "1px solid var(--vsdaw-border)",
              borderRadius: 4,
              backgroundColor: "var(--vsdaw-button-bg)",
              color: "var(--vsdaw-button-fg)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--vsdaw-button-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "var(--vsdaw-button-bg)";
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={4}
            style={{
              minWidth: 160,
              borderRadius: 4,
              padding: "4px 0",
              backgroundColor: "var(--vsdaw-panel-bg)",
              border: "1px solid var(--vsdaw-border)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              zIndex: 100,
            }}
          >
            <DropdownMenu.Item style={menuItemStyle} onClick={() => onAddTrack("audio")}>
              Audio Track
            </DropdownMenu.Item>
            <DropdownMenu.Item style={menuItemStyle} onClick={() => onAddTrack("midi")}>
              MIDI Track
            </DropdownMenu.Item>
            <DropdownMenu.Item style={menuItemStyle} onClick={() => onAddTrack("bus")}>
              Bus Track
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
};

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "6px 12px",
  backgroundColor: "transparent",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  fontSize: "inherit",
  textAlign: "left",
};
