import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Mic, MoreHorizontal, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import * as React from "react";
import type { AutomationTarget, DeviceParameter, TrackState } from "../../views/shared/types.js";

export interface TrackHeaderProps {
  track: TrackState;
  outputs?: { id: string; name: string }[];
  deviceParametersById?: Record<string, DeviceParameter[]>;
  onMute: () => void;
  onSolo: () => void;
  onArm: () => void;
  onVolume: (volume: number) => void;
  onPan: (pan: number) => void;
  onName: (name: string) => void;
  onDelete?: () => void;
  onSetColor?: (color: string) => void;
  onAddInsert?: (deviceName: string) => void;
  onAddAutomationLane?: (trackId: string, target: AutomationTarget) => void;
  onRemoveAutomationLane?: (laneId: string) => void;
  onGetDeviceParameters?: (deviceId: string) => void;
  onSetOutput?: (outputTrackId: string | null) => void;
}

const TRACK_COLORS = [
  { name: "Blue", value: "#3b82f6" },
  { name: "Red", value: "#ef4444" },
  { name: "Green", value: "#22c55e" },
  { name: "Yellow", value: "#eab308" },
  { name: "Purple", value: "#a855f7" },
  { name: "Orange", value: "#f97316" },
  { name: "Pink", value: "#ec4899" },
  { name: "Gray", value: "#6b7280" },
];

const INSERT_DEVICES = ["Reverb", "Delay", "Chorus", "Compressor", "EQ"];

export const TrackHeader: React.FC<TrackHeaderProps> = ({
  track,
  outputs,
  deviceParametersById,
  onMute,
  onSolo,
  onArm,
  onVolume,
  onPan,
  onName,
  onDelete,
  onSetColor,
  onAddInsert,
  onAddAutomationLane,
  onRemoveAutomationLane,
  onGetDeviceParameters,
  onSetOutput,
}) => {
  const [draftName, setDraftName] = React.useState(track.name);

  React.useEffect(() => {
    setDraftName(track.name);
  }, [track.name]);

  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== track.name) {
      onName(trimmed);
    } else {
      setDraftName(track.name);
    }
  };

  return (
    <div
      role="rowheader"
      aria-label={`Track ${track.name}`}
      style={{
        width: 180,
        minWidth: 180,
        minHeight: Math.max(64, track.height || 64),
        padding: "6px 8px",
        borderRight: "1px solid var(--vsdaw-border)",
        borderBottom: "1px solid var(--vsdaw-border)",
        backgroundColor: "var(--vsdaw-panel-bg)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            backgroundColor: track.color,
            flexShrink: 0,
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)",
          }}
        />
        <input
          aria-label="Track name"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={(e) => {
            commitName();
            e.currentTarget.style.borderColor = "transparent";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraftName(track.name);
              e.currentTarget.blur();
            }
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--vsdaw-input-border)";
          }}
          style={{
            flex: 1,
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: 3,
            color: "inherit",
            fontSize: "inherit",
            fontWeight: 500,
            padding: "2px 4px",
          }}
        />
        <TrackMenuButton onDelete={onDelete} onSetColor={onSetColor} onAddInsert={onAddInsert} />
        <TrackAutomationMenu
          track={track}
          deviceParametersById={deviceParametersById}
          onAddLane={onAddAutomationLane}
          onRemoveLane={onRemoveAutomationLane}
          onGetDeviceParameters={onGetDeviceParameters}
        />
      </div>

      {onSetOutput && outputs && outputs.length > 0 && (
        <select
          value={track.outputTrackId ?? ""}
          onChange={(e) => onSetOutput(e.target.value || null)}
          className="text-xs px-1 py-0.5 rounded border"
          style={{ backgroundColor: "var(--vsdaw-bg)", borderColor: "var(--vsdaw-border)", color: "inherit" }}
          aria-label="Output"
        >
          <option value="">Master</option>
          {outputs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <TrackToggleButton
          ariaLabel="Mute"
          active={track.muted}
          onClick={onMute}
          activeColor="var(--vsdaw-warning)"
        >
          {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700 }}>M</span>
        </TrackToggleButton>
        <TrackToggleButton
          ariaLabel="Solo"
          active={track.soloed}
          onClick={onSolo}
          activeColor="var(--vsdaw-button-bg)"
        >
          S
        </TrackToggleButton>
        <TrackToggleButton
          ariaLabel="Arm"
          active={track.armed}
          onClick={onArm}
          activeColor="var(--vsdaw-error)"
        >
          <Mic size={14} />
          <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700 }}>R</span>
        </TrackToggleButton>
      </div>

      <SliderRow
        id={`vol-${track.id}`}
        label="VOL"
        min={0}
        max={1}
        step={0.01}
        value={track.volume}
        onChange={onVolume}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <SliderRow
        id={`pan-${track.id}`}
        label="PAN"
        min={-1}
        max={1}
        step={0.01}
        value={track.pan}
        onChange={onPan}
        format={(v) =>
          v > 0 ? `R${Math.round(v * 100)}` : v < 0 ? `L${Math.round(-v * 100)}` : "C"
        }
      />
    </div>
  );
};

const TrackToggleButton: React.FC<{
  ariaLabel: string;
  active: boolean;
  onClick: () => void;
  activeColor: string;
  children: React.ReactNode;
}> = ({ ariaLabel, active, onClick, activeColor, children }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-pressed={active}
    onClick={onClick}
    style={{
      height: 28,
      minWidth: 40,
      padding: "0 8px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      border: "1px solid var(--vsdaw-border)",
      borderRadius: 4,
      backgroundColor: active ? activeColor : "transparent",
      color: active ? "var(--vsdaw-button-fg)" : "inherit",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
    }}
    onMouseLeave={(e) => {
      if (!active) e.currentTarget.style.backgroundColor = "transparent";
    }}
  >
    {children}
  </button>
);

const SliderRow: React.FC<{
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}> = ({ id, label, min, max, step, value, onChange, format }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto" }}>
    <label htmlFor={id} style={{ fontSize: 10, opacity: 0.8, minWidth: 24, fontWeight: 600 }}>
      {label}
    </label>
    <input
      id={id}
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number.parseFloat(e.target.value))}
      style={{ flex: 1, accentColor: "var(--vsdaw-button-bg)", cursor: "pointer" }}
    />
    <span
      aria-hidden
      style={{
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        minWidth: 32,
        textAlign: "right",
        fontWeight: 500,
      }}
    >
      {format(value)}
    </span>
  </div>
);

const TrackMenuButton: React.FC<{
  onDelete?: () => void;
  onSetColor?: (color: string) => void;
  onAddInsert?: (deviceName: string) => void;
}> = ({ onDelete, onSetColor, onAddInsert }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Track options"
          aria-haspopup="menu"
          aria-expanded={open}
          style={{
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid transparent",
            borderRadius: 4,
            backgroundColor: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          style={{
            minWidth: 180,
            borderRadius: 4,
            padding: "4px 0",
            backgroundColor: "var(--vsdaw-panel-bg)",
            border: "1px solid var(--vsdaw-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            zIndex: 100,
          }}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger style={menuItemStyle}>Add Insert</DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={2}
                style={{
                  minWidth: 140,
                  borderRadius: 4,
                  padding: "4px 0",
                  backgroundColor: "var(--vsdaw-panel-bg)",
                  border: "1px solid var(--vsdaw-border)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                  zIndex: 100,
                }}
              >
                {INSERT_DEVICES.map((device) => (
                  <DropdownMenu.Item
                    key={device}
                    style={menuItemStyle}
                    onClick={() => onAddInsert?.(device)}
                  >
                    {device}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger style={menuItemStyle}>Change Color</DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={2}
                style={{
                  minWidth: 140,
                  borderRadius: 4,
                  padding: "4px 0",
                  backgroundColor: "var(--vsdaw-panel-bg)",
                  border: "1px solid var(--vsdaw-border)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                  zIndex: 100,
                }}
              >
                {TRACK_COLORS.map((color) => (
                  <DropdownMenu.Item
                    key={color.value}
                    style={menuItemStyle}
                    onClick={() => onSetColor?.(color.value)}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 2,
                        backgroundColor: color.value,
                        marginRight: 8,
                        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)",
                      }}
                    />
                    {color.name}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator
            style={{ height: 1, backgroundColor: "var(--vsdaw-border)", margin: "4px 0" }}
          />

          <DropdownMenu.Item
            style={{ ...menuItemStyle, color: "var(--vsdaw-error)" }}
            onClick={onDelete}
          >
            Delete Track
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

const TrackAutomationMenu: React.FC<{
  track: TrackState;
  deviceParametersById?: Record<string, DeviceParameter[]>;
  onAddLane?: (trackId: string, target: AutomationTarget) => void;
  onRemoveLane?: (laneId: string) => void;
  onGetDeviceParameters?: (deviceId: string) => void;
}> = ({ track, deviceParametersById, onAddLane, onRemoveLane, onGetDeviceParameters }) => {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    for (const insert of track.inserts) {
      onGetDeviceParameters?.(insert.id);
    }
  }, [open, track.inserts, onGetDeviceParameters]);

  const addLane = (target: AutomationTarget) => {
    onAddLane?.(track.id, target);
    setOpen(false);
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Automation"
          aria-haspopup="menu"
          aria-expanded={open}
          style={{
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid transparent",
            borderRadius: 4,
            backgroundColor:
              track.automationLanes.length > 0 ? "var(--vsdaw-active-bg)" : "transparent",
            color: track.automationLanes.length > 0 ? "var(--vsdaw-button-fg)" : "inherit",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            if (track.automationLanes.length === 0)
              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
          }}
          onMouseLeave={(e) => {
            if (track.automationLanes.length === 0)
              e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <SlidersHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          style={{
            minWidth: 180,
            borderRadius: 4,
            padding: "4px 0",
            backgroundColor: "var(--vsdaw-panel-bg)",
            border: "1px solid var(--vsdaw-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            zIndex: 100,
          }}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger style={menuItemStyle}>Add Lane</DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={2}
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
                <DropdownMenu.Item
                  style={menuItemStyle}
                  onClick={() => addLane({ type: "volume", trackId: track.id })}
                >
                  Volume
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  style={menuItemStyle}
                  onClick={() => addLane({ type: "pan", trackId: track.id })}
                >
                  Pan
                </DropdownMenu.Item>
                {track.inserts.length > 0 && (
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger style={menuItemStyle}>
                      Device Parameter
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent
                        sideOffset={2}
                        style={{
                          minWidth: 180,
                          borderRadius: 4,
                          padding: "4px 0",
                          backgroundColor: "var(--vsdaw-panel-bg)",
                          border: "1px solid var(--vsdaw-border)",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                          zIndex: 100,
                        }}
                      >
                        {track.inserts.map((insert) => (
                          <DropdownMenu.Sub key={insert.id}>
                            <DropdownMenu.SubTrigger style={menuItemStyle}>
                              {insert.name}
                            </DropdownMenu.SubTrigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.SubContent
                                sideOffset={2}
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
                                {(deviceParametersById?.[insert.id] ?? []).map((param) => (
                                  <DropdownMenu.Item
                                    key={param.name}
                                    style={menuItemStyle}
                                    onClick={() =>
                                      addLane({
                                        type: "device",
                                        trackId: track.id,
                                        deviceId: insert.id,
                                        parameter: param.name,
                                      })
                                    }
                                  >
                                    {param.name}
                                  </DropdownMenu.Item>
                                ))}
                                {(deviceParametersById?.[insert.id] ?? []).length === 0 && (
                                  <DropdownMenu.Item disabled style={menuItemStyle}>
                                    No parameters
                                  </DropdownMenu.Item>
                                )}
                              </DropdownMenu.SubContent>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Sub>
                        ))}
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          {track.automationLanes.length > 0 && (
            <>
              <DropdownMenu.Separator
                style={{ height: 1, backgroundColor: "var(--vsdaw-border)", margin: "4px 0" }}
              />
              {track.automationLanes.map((lane) => (
                <DropdownMenu.Item
                  key={lane.id}
                  style={{ ...menuItemStyle, color: "var(--vsdaw-error)" }}
                  onClick={() => onRemoveLane?.(lane.id)}
                >
                  Remove {lane.target.type === "device" ? lane.target.parameter : lane.target.type}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
