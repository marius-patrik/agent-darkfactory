import { X } from "lucide-react";
import type * as React from "react";
import type { DeviceParameter } from "../../views/shared/types.js";

export interface DevicePanelProps {
  deviceId: string;
  deviceName?: string;
  parameters: DeviceParameter[];
  onParameterChange: (parameter: string, value: number | boolean) => void;
  onClose?: () => void;
}

export const DevicePanel: React.FC<DevicePanelProps> = ({
  deviceName,
  parameters,
  onParameterChange,
  onClose,
}) => {
  return (
    <div
      role="dialog"
      aria-label={`${deviceName ?? "Device"} parameters`}
      style={{
        position: "absolute",
        right: 8,
        bottom: 8,
        width: 280,
        maxHeight: "70%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--vsdaw-panel-bg)",
        border: "1px solid var(--vsdaw-border)",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          borderBottom: "1px solid var(--vsdaw-border)",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>{deviceName ?? "Device"}</span>
        {onClose && (
          <button
            type="button"
            aria-label="Close device panel"
            onClick={onClose}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              padding: 0,
              border: "1px solid var(--vsdaw-border)",
              borderRadius: 2,
              backgroundColor: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
        {parameters.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.6 }}>No parameters available.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {parameters.map((param) => (
              <ParameterRow
                key={param.name}
                param={param}
                onChange={(value) => onParameterChange(param.name, value)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const ParameterRow: React.FC<{
  param: DeviceParameter;
  onChange: (value: number | boolean) => void;
}> = ({ param, onChange }) => {
  if (param.type === "boolean") {
    return (
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        <span>{param.name}</span>
        <input
          type="checkbox"
          checked={Boolean(param.value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  }

  const value = typeof param.value === "number" ? param.value : 0;
  const step = (param.max - param.min) / 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span>{param.name}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{value.toFixed(3)}</span>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={step || 0.001}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "var(--vsdaw-button-bg)" }}
      />
    </div>
  );
};
