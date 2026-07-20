import { ChevronDown, ChevronRight, Cpu, FileAudio, Folder, Music, Plug, Plus } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import type { BrowserNode, DeviceItem, PluginItem } from "../../views/shared/types.js";

export interface BrowserTreeProps {
  root: BrowserNode;
  onPreview: (nodeId: string) => void;
  onDragStart: (nodeId: string) => void;
  onAddToTrack?: (device: DeviceItem) => void;
}

export const BrowserTree: React.FC<BrowserTreeProps> = ({
  root,
  onPreview,
  onDragStart,
  onAddToTrack,
}) => {
  if ((root.children?.length ?? 0) === 0) {
    return (
      <output
        aria-live="polite"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--vsdaw-fg)",
          opacity: 0.5,
          fontSize: 12,
        }}
      >
        Browser is empty
      </output>
    );
  }

  return (
    <div
      role="tree"
      aria-label="Browser tree"
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        padding: "4px 0",
      }}
    >
      {root.children?.map((child: BrowserNode) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={0}
          onPreview={onPreview}
          onDragStart={onDragStart}
          onAddToTrack={onAddToTrack}
        />
      ))}
    </div>
  );
};

const TreeNode: React.FC<{
  node: BrowserNode;
  depth: number;
  onPreview: (nodeId: string) => void;
  onDragStart: (nodeId: string) => void;
  onAddToTrack?: (device: DeviceItem) => void;
}> = ({ node, depth, onPreview, onDragStart, onAddToTrack }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isLeaf = node.type === "file" || node.type === "device" || node.type === "plugin";
  const device = node.device;
  const plugin = node.plugin;
  const pluginAsDevice: DeviceItem | undefined = plugin
    ? { id: plugin.id.replace(/^plugin-/, ""), name: plugin.name, category: plugin.category }
    : undefined;
  const Icon =
    node.type === "folder"
      ? Folder
      : node.type === "device"
        ? Cpu
        : node.type === "plugin"
          ? Plug
          : node.name.toLowerCase().endsWith(".mid")
            ? Music
            : FileAudio;

  const handleActivate = () => {
    if (pluginAsDevice && onAddToTrack) {
      onAddToTrack(pluginAsDevice);
    } else if (isLeaf) {
      onPreview(node.id);
    } else if (hasChildren) {
      setExpanded((s) => !s);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" && hasChildren && !expanded) setExpanded(true);
    if (e.key === "ArrowLeft" && hasChildren && expanded) setExpanded(false);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleActivate();
    }
  };

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        draggable={isLeaf}
        onDragStart={() => onDragStart(node.id)}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label={node.name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 8px",
          paddingLeft: 8 + depth * 16,
          cursor: "pointer",
          outline: "none",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
        }}
        onFocus={(e) => {
          e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )
        ) : (
          <span style={{ width: 14 }} />
        )}
        <Icon size={14} />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {node.name}
        </span>
        {node.type === "device" && device && onAddToTrack && (
          <button
            type="button"
            aria-label={`Add ${node.name} to selected track`}
            title="Add to selected track"
            onClick={(e) => {
              e.stopPropagation();
              onAddToTrack(device);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              padding: 0,
              border: "1px solid var(--vsdaw-border)",
              borderRadius: 2,
              backgroundColor: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <Plus size={10} />
          </button>
        )}
      </div>
      {expanded && hasChildren && (
        <div role="group">
          {node.children?.map((child: BrowserNode) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onPreview={onPreview}
              onDragStart={onDragStart}
              onAddToTrack={onAddToTrack}
            />
          ))}
        </div>
      )}
    </div>
  );
};
