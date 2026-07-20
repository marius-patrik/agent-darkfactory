import type * as React from "react";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, subtitle, children }) => {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: "var(--vsdaw-fg)",
        opacity: 0.7,
        gap: 8,
        textAlign: "center",
      }}
    >
      {icon && <div style={{ opacity: 0.5 }}>{icon}</div>}
      <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, maxWidth: 320 }}>{subtitle}</div>}
      {children}
    </div>
  );
};
