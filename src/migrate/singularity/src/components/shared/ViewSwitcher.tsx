import type * as React from "react";
import type { ViewName } from "../../views/shared/types.js";

const VIEWS: { id: ViewName; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "mixer", label: "Mixer" },
  { id: "pianoRoll", label: "Piano Roll" },
  { id: "browser", label: "Browser" },
  { id: "graph", label: "Graph" },
];

export interface ViewSwitcherProps {
  active: ViewName;
  onChange: (view: ViewName) => void;
}

export const ViewSwitcher: React.FC<ViewSwitcherProps> = ({ active, onChange }) => {
  return (
    <div
      role="tablist"
      aria-label="View switcher"
      className="flex items-center rounded overflow-hidden"
      style={{
        border: "1px solid var(--vsdaw-border)",
        backgroundColor: "var(--vsdaw-bg)",
      }}
    >
      {VIEWS.map((view) => {
        const isActive = view.id === active;
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(view.id)}
            className="px-2.5 py-1 text-xs font-medium border-0 cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: isActive ? "var(--vsdaw-button-bg)" : "transparent",
              color: isActive ? "var(--vsdaw-button-fg)" : "var(--vsdaw-fg)",
              borderRight: "1px solid var(--vsdaw-border)",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
};
