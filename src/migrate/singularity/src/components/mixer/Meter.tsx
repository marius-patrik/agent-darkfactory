import type * as React from "react";

export interface MeterProps {
  value: number; // 0..1
  peak?: number; // 0..1
  orientation?: "vertical" | "horizontal";
}

export const Meter: React.FC<MeterProps> = ({ value, peak = 0, orientation = "vertical" }) => {
  const isVertical = orientation === "vertical";
  const clamped = Math.max(0, Math.min(1, value));
  const peakClamped = Math.max(0, Math.min(1, peak));

  return (
    <div
      aria-label="Level meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      role="meter"
      style={{
        width: isVertical ? 8 : "100%",
        height: isVertical ? "100%" : 8,
        backgroundColor: "var(--vsdaw-input-bg)",
        borderRadius: 2,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          [isVertical ? "bottom" : "left"]: 0,
          [isVertical ? "width" : "height"]: "100%",
          [isVertical ? "height" : "width"]: `${clamped * 100}%`,
          background: isVertical
            ? "linear-gradient(to top, #22c55e 60%, #eab308 80%, #ef4444 100%)"
            : "linear-gradient(to right, #22c55e 60%, #eab308 80%, #ef4444 100%)",
        }}
      />
      {peak > 0 && (
        <div
          style={{
            position: "absolute",
            [isVertical ? "bottom" : "left"]: `${peakClamped * 100}%`,
            [isVertical ? "width" : "height"]: "100%",
            [isVertical ? "height" : "width"]: 2,
            backgroundColor: "var(--vsdaw-error)",
          }}
        />
      )}
    </div>
  );
};
