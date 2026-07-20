OpenAI Codex v0.142.2
--------
workdir: /private/tmp/vsdaw-issue23
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019f09bc-e29f-74e3-84a8-701e27639015
--------
user
commit HEAD
exec
/bin/zsh -lc 'git status --short && git rev-parse --show-toplevel && git rev-parse HEAD && git show --stat --oneline --decorate --no-renames HEAD' in /private/tmp/vsdaw-issue23
 succeeded in 9784ms:
2026-06-27 17:40:07.060 xcodebuild[8700:10870356]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:07.237 xcodebuild[8700:10870355] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-saDQSa8k' (errno=Operation not permitted)
2026-06-27 17:40:07.888 xcodebuild[8702:10870392]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:08.064 xcodebuild[8702:10870391] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
?? node_modules
?? reviews/issue-23-475832d.md
?? reviews/issue-23-e59fc6b.md
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-XRKJv7ra' (errno=Operation not permitted)
2026-06-27 17:40:09.505 xcodebuild[8710:10870423]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:09.679 xcodebuild[8710:10870422] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-7ukxcMLc' (errno=Operation not permitted)
2026-06-27 17:40:10.321 xcodebuild[8712:10870436]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:10.496 xcodebuild[8712:10870435] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
/private/tmp/vsdaw-issue23
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-AzuN8FEn' (errno=Operation not permitted)
2026-06-27 17:40:11.942 xcodebuild[8717:10870461]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:12.126 xcodebuild[8717:10870460] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-WU9ujqrY' (errno=Operation not permitted)
2026-06-27 17:40:12.767 xcodebuild[8719:10870471]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:12.945 xcodebuild[8719:10870470] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
e59fc6b109b8643e0fc5a890427805bc876c3db9
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-6m7CHgCP' (errno=Operation not permitted)
2026-06-27 17:40:14.411 xcodebuild[8726:10870507]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:14.586 xcodebuild[8726:10870506] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-KOOUjSWL' (errno=Operation not permitted)
2026-06-27 17:40:15.227 xcodebuild[8728:10870517]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:15.412 xcodebuild[8728:10870516] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
e59fc6b (HEAD -> issue/23-feature) feat(timeline): add automation lane UI and interactions (#23)
 src/components/timeline/TimelineCanvas.tsx | 206 ++++++++++++++++++++++++++++-
 src/components/timeline/TrackHeader.tsx    | 206 ++++++++++++++++++++++++++++-
 src/views/shared/types.ts                  |  27 ++++
 src/views/shared/useViewState.ts           |  21 +++
 src/views/timeline/main.tsx                |   7 +
 5 files changed, 460 insertions(+), 7 deletions(-)

exec
/bin/zsh -lc 'git diff HEAD''^..HEAD -- src/components/timeline/TimelineCanvas.tsx src/components/timeline/TrackHeader.tsx src/views/shared/types.ts src/views/shared/useViewState.ts src/views/timeline/main.tsx' in /private/tmp/vsdaw-issue23
 succeeded in 2423ms:
2026-06-27 17:40:21.237 xcodebuild[8737:10870613]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:21.410 xcodebuild[8737:10870612] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-laCNPxR9' (errno=Operation not permitted)
2026-06-27 17:40:22.060 xcodebuild[8739:10870623]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 17:40:22.236 xcodebuild[8739:10870622] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/src/components/timeline/TimelineCanvas.tsx b/src/components/timeline/TimelineCanvas.tsx
index 2c8f6d0..2c6424d 100644
--- a/src/components/timeline/TimelineCanvas.tsx
+++ b/src/components/timeline/TimelineCanvas.tsx
@@ -1,4 +1,5 @@
 import * as React from "react";
+import { AUTOMATION_LANE_HEIGHT } from "../../shared/automation.js";
 import type { TrackState } from "../../views/shared/types.js";
 
 const BEAT_WIDTH = 40;
@@ -15,6 +16,9 @@ export interface TimelineCanvasProps {
   onSeek: (beats: number) => void;
   onSelectRegion: (regionId: string | null) => void;
   onMoveRegion: (regionId: string, start: number) => void;
+  onAddAutomationPoint?: (laneId: string, position: number, value: number) => void;
+  onMoveAutomationPoint?: (pointId: string, position: number, value: number) => void;
+  onDeleteAutomationPoint?: (pointId: string) => void;
 }
 
 interface CanvasSize {
@@ -62,6 +66,9 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
   onSeek,
   onSelectRegion,
   onMoveRegion,
+  onAddAutomationPoint,
+  onMoveAutomationPoint,
+  onDeleteAutomationPoint,
 }) => {
   const canvasRef = React.useRef<HTMLCanvasElement>(null);
   const containerRef = React.useRef<HTMLDivElement>(null);
@@ -70,15 +77,32 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
   const [drag, setDrag] = React.useState<
     | { type: "seek"; startX: number }
     | { type: "region"; regionId: string; startBeats: number; startX: number }
+    | {
+        type: "automation";
+        pointId: string;
+        laneId: string;
+        startBeats: number;
+        startValue: number;
+        startX: number;
+        startY: number;
+      }
     | null
   >(null);
   const pendingMoveRef = React.useRef<{ regionId: string; start: number } | null>(null);
+  const [dragPoint, setDragPoint] = React.useState<{
+    pointId: string;
+    position: number;
+    value: number;
+  } | null>(null);
 
   const sizedTracks = React.useMemo(
     () =>
       tracks.map((t) => ({
         ...t,
-        height: Math.max(MIN_TRACK_HEIGHT, t.height || MIN_TRACK_HEIGHT),
+        height: Math.max(
+          MIN_TRACK_HEIGHT + (t.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
+          t.height || MIN_TRACK_HEIGHT,
+        ),
       })),
     [tracks],
   );
@@ -88,6 +112,12 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
     [sizedTracks],
   );
 
+  const regionHeightForTrack = (track: (typeof sizedTracks)[number]) =>
+    Math.max(
+      MIN_TRACK_HEIGHT - 8,
+      track.height - (track.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
+    );
+
   const { width, height, dpr } = useCanvasSize(containerRef);
 
   React.useEffect(() => {
@@ -177,22 +207,78 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
       ctx.lineTo(drawWidth, y + track.height);
       ctx.stroke();
 
+      const regionHeight = regionHeightForTrack(track);
       for (const region of track.regions) {
         const rx = region.start * beatWidth - scrollX;
         const rw = Math.max(4, region.duration * beatWidth);
         if (rx + rw < 0 || rx > drawWidth) continue;
         ctx.fillStyle = region.color || track.color;
         ctx.globalAlpha = 0.85;
-        ctx.fillRect(rx + 1, y + 4, rw - 2, track.height - 8);
+        ctx.fillRect(rx + 1, y + 4, rw - 2, regionHeight - 8);
         ctx.globalAlpha = 1;
         ctx.fillStyle = fg;
         ctx.save();
         ctx.beginPath();
-        ctx.rect(rx + 6, y + 4, Math.max(0, rw - 12), track.height - 8);
+        ctx.rect(rx + 6, y + 4, Math.max(0, rw - 12), regionHeight - 8);
         ctx.clip();
-        ctx.fillText(region.name, rx + 6, y + track.height / 2);
+        ctx.fillText(region.name, rx + 6, y + regionHeight / 2);
         ctx.restore();
       }
+
+      // Automation lanes
+      let laneY = y + regionHeight;
+      for (const lane of track.automationLanes ?? []) {
+        ctx.fillStyle = border;
+        ctx.globalAlpha = 0.05;
+        ctx.fillRect(0, laneY, drawWidth, AUTOMATION_LANE_HEIGHT);
+        ctx.globalAlpha = 1;
+        ctx.strokeStyle = border;
+        ctx.beginPath();
+        ctx.moveTo(0, laneY + AUTOMATION_LANE_HEIGHT);
+        ctx.lineTo(drawWidth, laneY + AUTOMATION_LANE_HEIGHT);
+        ctx.stroke();
+
+        const centerY = laneY + AUTOMATION_LANE_HEIGHT / 2;
+        ctx.strokeStyle = track.color;
+        ctx.lineWidth = 1.5;
+        ctx.beginPath();
+        const displayPoints = dragPoint
+          ? lane.points.map((p) =>
+              p.id === dragPoint.pointId
+                ? { ...p, position: dragPoint.position, value: dragPoint.value }
+                : p,
+            )
+          : lane.points;
+        const sorted = [...displayPoints].sort((a, b) => a.position - b.position);
+        if (sorted.length === 0) {
+          ctx.moveTo(0, centerY);
+          ctx.lineTo(drawWidth, centerY);
+        } else {
+          for (let i = 0; i < sorted.length - 1; i++) {
+            const x0 = sorted[i].position * beatWidth - scrollX;
+            const y0 = laneY + AUTOMATION_LANE_HEIGHT - sorted[i].value * AUTOMATION_LANE_HEIGHT;
+            const x1 = sorted[i + 1].position * beatWidth - scrollX;
+            const y1 =
+              laneY + AUTOMATION_LANE_HEIGHT - sorted[i + 1].value * AUTOMATION_LANE_HEIGHT;
+            if (x1 < 0 || x0 > drawWidth) continue;
+            ctx.moveTo(x0, y0);
+            ctx.lineTo(x1, y1);
+          }
+        }
+        ctx.stroke();
+
+        for (const point of sorted) {
+          const px = point.position * beatWidth - scrollX;
+          const py = laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT;
+          if (px < -4 || px > drawWidth + 4) continue;
+          ctx.fillStyle = fg;
+          ctx.beginPath();
+          ctx.arc(px, py, 3, 0, Math.PI * 2);
+          ctx.fill();
+        }
+        laneY += AUTOMATION_LANE_HEIGHT;
+      }
+
       y += track.height;
     }
 
@@ -216,6 +302,7 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
     dpr,
     totalHeight,
     timeSignatureNumerator,
+    dragPoint,
   ]);
 
   // Flush pending region move on mouse up (throttle bus traffic).
@@ -226,6 +313,56 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
     }
   }, [onMoveRegion]);
 
+  const findAutomationPoint = (clientX: number, clientY: number) => {
+    const canvas = canvasRef.current;
+    if (!canvas) return undefined;
+    const rect = canvas.getBoundingClientRect();
+    const x = clientX - rect.left + scrollX;
+    const y = clientY - rect.top;
+    let trackY = HEADER_HEIGHT + RULER_HEIGHT;
+    for (const track of sizedTracks) {
+      const regionHeight = regionHeightForTrack(track);
+      let laneY = trackY + regionHeight;
+      for (const lane of track.automationLanes ?? []) {
+        if (y >= laneY && y < laneY + AUTOMATION_LANE_HEIGHT) {
+          for (const point of lane.points) {
+            const px = point.position * BEAT_WIDTH * scale;
+            const py = laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT;
+            const dx = x - px;
+            const dy = y - py;
+            if (dx * dx + dy * dy <= 36) {
+              return { point, lane, laneY };
+            }
+          }
+        }
+        laneY += AUTOMATION_LANE_HEIGHT;
+      }
+      trackY += track.height;
+    }
+    return undefined;
+  };
+
+  const findAutomationLaneAt = (clientX: number, clientY: number) => {
+    const canvas = canvasRef.current;
+    if (!canvas) return undefined;
+    const rect = canvas.getBoundingClientRect();
+    const x = clientX - rect.left + scrollX;
+    const y = clientY - rect.top;
+    let trackY = HEADER_HEIGHT + RULER_HEIGHT;
+    for (const track of sizedTracks) {
+      const regionHeight = regionHeightForTrack(track);
+      let laneY = trackY + regionHeight;
+      for (const lane of track.automationLanes ?? []) {
+        if (y >= laneY && y < laneY + AUTOMATION_LANE_HEIGHT) {
+          return { lane, laneY, x };
+        }
+        laneY += AUTOMATION_LANE_HEIGHT;
+      }
+      trackY += track.height;
+    }
+    return undefined;
+  };
+
   const handleWheel = (e: React.WheelEvent) => {
     if (e.ctrlKey || e.metaKey) {
       e.preventDefault();
@@ -251,7 +388,8 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
     // Hit-test regions
     let y = HEADER_HEIGHT + RULER_HEIGHT;
     for (const track of sizedTracks) {
-      if (e.clientY - rect.top >= y && e.clientY - rect.top < y + track.height) {
+      const regionHeight = regionHeightForTrack(track);
+      if (e.clientY - rect.top >= y && e.clientY - rect.top < y + regionHeight) {
         for (const region of track.regions) {
           const rx = region.start * BEAT_WIDTH * scale;
           const rw = Math.max(4, region.duration * BEAT_WIDTH * scale);
@@ -270,6 +408,38 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
       y += track.height;
     }
 
+    // Hit-test automation points
+    const hitPoint = findAutomationPoint(e.clientX, e.clientY);
+    if (hitPoint) {
+      const { point, lane, laneY } = hitPoint;
+      setDrag({
+        type: "automation",
+        pointId: point.id,
+        laneId: lane.id,
+        startBeats: point.position,
+        startValue: point.value,
+        startX: e.clientX,
+        startY: laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT,
+      });
+      return;
+    }
+
+    // Click on automation lane adds a point
+    const hitLane = findAutomationLaneAt(e.clientX, e.clientY);
+    if (hitLane) {
+      const { lane, laneY, x: localX } = hitLane;
+      const position = Math.max(0, localX / (BEAT_WIDTH * scale));
+      const value = Math.max(
+        0,
+        Math.min(
+          1,
+          (laneY + AUTOMATION_LANE_HEIGHT - e.clientY + rect.top) / AUTOMATION_LANE_HEIGHT,
+        ),
+      );
+      onAddAutomationPoint?.(lane.id, position, value);
+      return;
+    }
+
     onSelectRegion(null);
     onSeek(Math.max(0, beats));
     setDrag({ type: "seek", startX: e.clientX });
@@ -291,14 +461,39 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
         regionId: drag.regionId,
         start: Math.max(0, drag.startBeats + deltaBeats),
       };
+    } else if (drag.type === "automation") {
+      const canvas = canvasRef.current;
+      if (!canvas) return;
+      const rect = canvas.getBoundingClientRect();
+      const deltaPixelsX = e.clientX - drag.startX;
+      const deltaPixelsY = e.clientY - rect.top - (drag.startY - rect.top);
+      const deltaBeats = deltaPixelsX / (BEAT_WIDTH * scale);
+      const deltaValue = -deltaPixelsY / AUTOMATION_LANE_HEIGHT;
+      setDragPoint({
+        pointId: drag.pointId,
+        position: Math.max(0, drag.startBeats + deltaBeats),
+        value: Math.max(0, Math.min(1, drag.startValue + deltaValue)),
+      });
     }
   };
 
   const handleMouseUp = () => {
     flushPendingMove();
+    if (drag?.type === "automation" && dragPoint) {
+      onMoveAutomationPoint?.(dragPoint.pointId, dragPoint.position, dragPoint.value);
+    }
+    setDragPoint(null);
     setDrag(null);
   };
 
+  const handleContextMenu = (e: React.MouseEvent) => {
+    e.preventDefault();
+    const hit = findAutomationPoint(e.clientX, e.clientY);
+    if (hit) {
+      onDeleteAutomationPoint?.(hit.point.id);
+    }
+  };
+
   const emptyState = sizedTracks.length === 0 && (
     <output
       aria-live="polite"
@@ -332,6 +527,7 @@ export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
         onMouseMove={handleMouseMove}
         onMouseUp={handleMouseUp}
         onMouseLeave={handleMouseUp}
+        onContextMenu={handleContextMenu}
         style={{
           display: "block",
           width: width > 0 ? width : "100%",
diff --git a/src/components/timeline/TrackHeader.tsx b/src/components/timeline/TrackHeader.tsx
index 7acc49b..5186dd5 100644
--- a/src/components/timeline/TrackHeader.tsx
+++ b/src/components/timeline/TrackHeader.tsx
@@ -1,10 +1,11 @@
 import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
-import { Mic, MoreHorizontal, Volume2, VolumeX } from "lucide-react";
+import { Mic, MoreHorizontal, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
 import * as React from "react";
-import type { TrackState } from "../../views/shared/types.js";
+import type { AutomationTarget, DeviceParameter, TrackState } from "../../views/shared/types.js";
 
 export interface TrackHeaderProps {
   track: TrackState;
+  deviceParametersById?: Record<string, DeviceParameter[]>;
   onMute: () => void;
   onSolo: () => void;
   onArm: () => void;
@@ -14,6 +15,9 @@ export interface TrackHeaderProps {
   onDelete?: () => void;
   onSetColor?: (color: string) => void;
   onAddInsert?: (deviceName: string) => void;
+  onAddAutomationLane?: (trackId: string, target: AutomationTarget) => void;
+  onRemoveAutomationLane?: (laneId: string) => void;
+  onGetDeviceParameters?: (deviceId: string) => void;
 }
 
 const TRACK_COLORS = [
@@ -31,6 +35,7 @@ const INSERT_DEVICES = ["Reverb", "Delay", "Chorus", "Compressor", "EQ"];
 
 export const TrackHeader: React.FC<TrackHeaderProps> = ({
   track,
+  deviceParametersById,
   onMute,
   onSolo,
   onArm,
@@ -40,6 +45,9 @@ export const TrackHeader: React.FC<TrackHeaderProps> = ({
   onDelete,
   onSetColor,
   onAddInsert,
+  onAddAutomationLane,
+  onRemoveAutomationLane,
+  onGetDeviceParameters,
 }) => {
   const [draftName, setDraftName] = React.useState(track.name);
 
@@ -115,6 +123,13 @@ export const TrackHeader: React.FC<TrackHeaderProps> = ({
           }}
         />
         <TrackMenuButton onDelete={onDelete} onSetColor={onSetColor} onAddInsert={onAddInsert} />
+        <TrackAutomationMenu
+          track={track}
+          deviceParametersById={deviceParametersById}
+          onAddLane={onAddAutomationLane}
+          onRemoveLane={onRemoveAutomationLane}
+          onGetDeviceParameters={onGetDeviceParameters}
+        />
       </div>
 
       <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
@@ -384,6 +399,193 @@ const TrackMenuButton: React.FC<{
   );
 };
 
+const TrackAutomationMenu: React.FC<{
+  track: TrackState;
+  deviceParametersById?: Record<string, DeviceParameter[]>;
+  onAddLane?: (trackId: string, target: AutomationTarget) => void;
+  onRemoveLane?: (laneId: string) => void;
+  onGetDeviceParameters?: (deviceId: string) => void;
+}> = ({ track, deviceParametersById, onAddLane, onRemoveLane, onGetDeviceParameters }) => {
+  const [open, setOpen] = React.useState(false);
+
+  React.useEffect(() => {
+    if (!open) return;
+    for (const insert of track.inserts) {
+      onGetDeviceParameters?.(insert.id);
+    }
+  }, [open, track.inserts, onGetDeviceParameters]);
+
+  const addLane = (target: AutomationTarget) => {
+    onAddLane?.(track.id, target);
+    setOpen(false);
+  };
+
+  return (
+    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
+      <DropdownMenu.Trigger asChild>
+        <button
+          type="button"
+          aria-label="Automation"
+          aria-haspopup="menu"
+          aria-expanded={open}
+          style={{
+            width: 24,
+            height: 24,
+            display: "inline-flex",
+            alignItems: "center",
+            justifyContent: "center",
+            border: "1px solid transparent",
+            borderRadius: 4,
+            backgroundColor:
+              track.automationLanes.length > 0 ? "var(--vsdaw-active-bg)" : "transparent",
+            color: track.automationLanes.length > 0 ? "var(--vsdaw-button-fg)" : "inherit",
+            cursor: "pointer",
+          }}
+          onMouseEnter={(e) => {
+            if (track.automationLanes.length === 0)
+              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+          }}
+          onMouseLeave={(e) => {
+            if (track.automationLanes.length === 0)
+              e.currentTarget.style.backgroundColor = "transparent";
+          }}
+        >
+          <SlidersHorizontal size={14} />
+        </button>
+      </DropdownMenu.Trigger>
+      <DropdownMenu.Portal>
+        <DropdownMenu.Content
+          side="bottom"
+          align="end"
+          sideOffset={4}
+          style={{
+            minWidth: 180,
+            borderRadius: 4,
+            padding: "4px 0",
+            backgroundColor: "var(--vsdaw-panel-bg)",
+            border: "1px solid var(--vsdaw-border)",
+            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
+            zIndex: 100,
+          }}
+        >
+          <DropdownMenu.Sub>
+            <DropdownMenu.SubTrigger style={menuItemStyle}>Add Lane</DropdownMenu.SubTrigger>
+            <DropdownMenu.Portal>
+              <DropdownMenu.SubContent
+                sideOffset={2}
+                style={{
+                  minWidth: 160,
+                  borderRadius: 4,
+                  padding: "4px 0",
+                  backgroundColor: "var(--vsdaw-panel-bg)",
+                  border: "1px solid var(--vsdaw-border)",
+                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
+                  zIndex: 100,
+                }}
+              >
+                <DropdownMenu.Item
+                  style={menuItemStyle}
+                  onClick={() => addLane({ type: "volume", trackId: track.id })}
+                >
+                  Volume
+                </DropdownMenu.Item>
+                <DropdownMenu.Item
+                  style={menuItemStyle}
+                  onClick={() => addLane({ type: "pan", trackId: track.id })}
+                >
+                  Pan
+                </DropdownMenu.Item>
+                {track.inserts.length > 0 && (
+                  <DropdownMenu.Sub>
+                    <DropdownMenu.SubTrigger style={menuItemStyle}>
+                      Device Parameter
+                    </DropdownMenu.SubTrigger>
+                    <DropdownMenu.Portal>
+                      <DropdownMenu.SubContent
+                        sideOffset={2}
+                        style={{
+                          minWidth: 180,
+                          borderRadius: 4,
+                          padding: "4px 0",
+                          backgroundColor: "var(--vsdaw-panel-bg)",
+                          border: "1px solid var(--vsdaw-border)",
+                          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
+                          zIndex: 100,
+                        }}
+                      >
+                        {track.inserts.map((insert) => (
+                          <DropdownMenu.Sub key={insert.id}>
+                            <DropdownMenu.SubTrigger style={menuItemStyle}>
+                              {insert.name}
+                            </DropdownMenu.SubTrigger>
+                            <DropdownMenu.Portal>
+                              <DropdownMenu.SubContent
+                                sideOffset={2}
+                                style={{
+                                  minWidth: 160,
+                                  borderRadius: 4,
+                                  padding: "4px 0",
+                                  backgroundColor: "var(--vsdaw-panel-bg)",
+                                  border: "1px solid var(--vsdaw-border)",
+                                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
+                                  zIndex: 100,
+                                }}
+                              >
+                                {(deviceParametersById?.[insert.id] ?? []).map((param) => (
+                                  <DropdownMenu.Item
+                                    key={param.name}
+                                    style={menuItemStyle}
+                                    onClick={() =>
+                                      addLane({
+                                        type: "device",
+                                        trackId: track.id,
+                                        deviceId: insert.id,
+                                        parameter: param.name,
+                                      })
+                                    }
+                                  >
+                                    {param.name}
+                                  </DropdownMenu.Item>
+                                ))}
+                                {(deviceParametersById?.[insert.id] ?? []).length === 0 && (
+                                  <DropdownMenu.Item disabled style={menuItemStyle}>
+                                    No parameters
+                                  </DropdownMenu.Item>
+                                )}
+                              </DropdownMenu.SubContent>
+                            </DropdownMenu.Portal>
+                          </DropdownMenu.Sub>
+                        ))}
+                      </DropdownMenu.SubContent>
+                    </DropdownMenu.Portal>
+                  </DropdownMenu.Sub>
+                )}
+              </DropdownMenu.SubContent>
+            </DropdownMenu.Portal>
+          </DropdownMenu.Sub>
+
+          {track.automationLanes.length > 0 && (
+            <>
+              <DropdownMenu.Separator
+                style={{ height: 1, backgroundColor: "var(--vsdaw-border)", margin: "4px 0" }}
+              />
+              {track.automationLanes.map((lane) => (
+                <DropdownMenu.Item
+                  key={lane.id}
+                  style={{ ...menuItemStyle, color: "var(--vsdaw-error)" }}
+                  onClick={() => onRemoveLane?.(lane.id)}
+                >
+                  Remove {lane.target.type === "device" ? lane.target.parameter : lane.target.type}
+                </DropdownMenu.Item>
+              ))}
+            </>
+          )}
+        </DropdownMenu.Content>
+      </DropdownMenu.Portal>
+    </DropdownMenu.Root>
+  );
+};
+
 const menuItemStyle: React.CSSProperties = {
   display: "flex",
   alignItems: "center",
diff --git a/src/views/shared/types.ts b/src/views/shared/types.ts
index a862633..a8b3781 100644
--- a/src/views/shared/types.ts
+++ b/src/views/shared/types.ts
@@ -24,6 +24,27 @@ export interface TimeSignature {
   denominator: number;
 }
 
+export interface AutomationTarget {
+  type: "volume" | "pan" | "device";
+  trackId: string;
+  deviceId?: string;
+  parameter?: string;
+}
+
+export interface AutomationPoint {
+  id: string;
+  laneId: string;
+  position: number;
+  value: number;
+}
+
+export interface AutomationLane {
+  id: string;
+  trackId: string;
+  target: AutomationTarget;
+  points: AutomationPoint[];
+}
+
 export interface TrackState {
   id: string;
   name: string;
@@ -36,6 +57,7 @@ export interface TrackState {
   height: number;
   inserts: ProtocolInsertState[];
   regions: RegionState[];
+  automationLanes: AutomationLane[];
 }
 
 export interface RegionState {
@@ -108,6 +130,11 @@ export type ViewMessage =
     }
   | { type: "timeline/selectRegion"; regionId: string | null }
   | { type: "timeline/moveRegion"; regionId: string; start: number }
+  | { type: "automation/addLane"; trackId: string; target: AutomationTarget }
+  | { type: "automation/removeLane"; laneId: string }
+  | { type: "automation/addPoint"; laneId: string; position: number; value: number }
+  | { type: "automation/movePoint"; pointId: string; position?: number; value?: number }
+  | { type: "automation/deletePoint"; pointId: string }
   | { type: "pianoRoll/addNote"; note: NoteState }
   | { type: "pianoRoll/setNoteVelocity"; noteId: string; velocity: number }
   | { type: "pianoRoll/deleteNote"; noteId: string }
diff --git a/src/views/shared/useViewState.ts b/src/views/shared/useViewState.ts
index bdf2bb4..db213ab 100644
--- a/src/views/shared/useViewState.ts
+++ b/src/views/shared/useViewState.ts
@@ -1,6 +1,7 @@
 import { useCallback, useEffect, useState } from "react";
 import { messageBus } from "./messageBus.js";
 import type {
+  AutomationTarget,
   BrowserNode,
   DeviceCategory,
   DeviceParameter,
@@ -34,6 +35,9 @@ export function useViewState(view: ViewName) {
     deviceId: string;
     parameters: DeviceParameter[];
   } | null>(null);
+  const [deviceParametersById, setDeviceParametersById] = useState<
+    Record<string, DeviceParameter[]>
+  >({});
   const [error, setError] = useState<string | null>(null);
 
   const send = useCallback((message: ViewMessage) => {
@@ -70,6 +74,10 @@ export function useViewState(view: ViewName) {
           break;
         case "host/deviceParameters":
           setDeviceParameters({ deviceId: message.deviceId, parameters: message.parameters });
+          setDeviceParametersById((prev) => ({
+            ...prev,
+            [message.deviceId]: message.parameters,
+          }));
           break;
         case "host/error":
           setError(message.message);
@@ -117,6 +125,17 @@ export function useViewState(view: ViewName) {
       send({ type: "timeline/moveRegion", regionId, start }),
   };
 
+  const automationActions = {
+    addLane: (trackId: string, target: AutomationTarget) =>
+      send({ type: "automation/addLane", trackId, target }),
+    removeLane: (laneId: string) => send({ type: "automation/removeLane", laneId }),
+    addPoint: (laneId: string, position: number, value: number) =>
+      send({ type: "automation/addPoint", laneId, position, value }),
+    movePoint: (pointId: string, position?: number, value?: number) =>
+      send({ type: "automation/movePoint", pointId, position, value }),
+    deletePoint: (pointId: string) => send({ type: "automation/deletePoint", pointId }),
+  };
+
   const mixerActions = {
     openDevice: (trackId: string, slotIndex: number) =>
       send({ type: "mixer/openDevice", trackId, slotIndex }),
@@ -159,10 +178,12 @@ export function useViewState(view: ViewName) {
     selection,
     browserRoot,
     deviceParameters,
+    deviceParametersById,
     error,
     transport,
     trackActions,
     timelineActions,
+    automationActions,
     mixerActions,
     deviceActions,
     browserActions,
diff --git a/src/views/timeline/main.tsx b/src/views/timeline/main.tsx
index b39459d..c36307d 100644
--- a/src/views/timeline/main.tsx
+++ b/src/views/timeline/main.tsx
@@ -132,6 +132,7 @@ const TimelineView: React.FC = () => {
                 <TrackHeader
                   key={track.id}
                   track={track}
+                  deviceParametersById={state.deviceParametersById}
                   onMute={() => state.trackActions.setMute(track.id, !track.muted)}
                   onSolo={() => state.trackActions.setSolo(track.id, !track.soloed)}
                   onArm={() => state.trackActions.setArm(track.id, !track.armed)}
@@ -143,6 +144,9 @@ const TimelineView: React.FC = () => {
                   onAddInsert={(deviceName: string) =>
                     state.trackActions.addInsert(track.id, deviceName)
                   }
+                  onAddAutomationLane={state.automationActions.addLane}
+                  onRemoveAutomationLane={state.automationActions.removeLane}
+                  onGetDeviceParameters={state.deviceActions.getParameters}
                 />
               ))}
             </div>
@@ -157,6 +161,9 @@ const TimelineView: React.FC = () => {
                   onSeek={state.transport.seek}
                   onSelectRegion={state.timelineActions.selectRegion}
                   onMoveRegion={state.timelineActions.moveRegion}
+                  onAddAutomationPoint={state.automationActions.addPoint}
+                  onMoveAutomationPoint={state.automationActions.movePoint}
+                  onDeleteAutomationPoint={state.automationActions.deletePoint}
                 />
               ) : (
                 <EmptyState

exec
/bin/zsh -lc "sed -n '1,260p' src/components/timeline/TimelineCanvas.tsx && sed -n '260,580p' src/components/timeline/TimelineCanvas.tsx" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
import * as React from "react";
import { AUTOMATION_LANE_HEIGHT } from "../../shared/automation.js";
import type { TrackState } from "../../views/shared/types.js";

const BEAT_WIDTH = 40;
const HEADER_HEIGHT = 24;
const RULER_HEIGHT = 24;
const MIN_TRACK_HEIGHT = 60;

export interface TimelineCanvasProps {
  tracks: TrackState[];
  positionBeats: number;
  loopStart: number;
  loopEnd: number;
  timeSignatureNumerator?: number;
  onSeek: (beats: number) => void;
  onSelectRegion: (regionId: string | null) => void;
  onMoveRegion: (regionId: string, start: number) => void;
  onAddAutomationPoint?: (laneId: string, position: number, value: number) => void;
  onMoveAutomationPoint?: (pointId: string, position: number, value: number) => void;
  onDeleteAutomationPoint?: (pointId: string) => void;
}

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

function useCanvasSize(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = React.useState<CanvasSize>({ width: 0, height: 0, dpr: 1 });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
        dpr,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [containerRef]);

  return size;
}

export const TimelineCanvas: React.FC<TimelineCanvasProps> = ({
  tracks,
  positionBeats,
  loopStart,
  loopEnd,
  timeSignatureNumerator = 4,
  onSeek,
  onSelectRegion,
  onMoveRegion,
  onAddAutomationPoint,
  onMoveAutomationPoint,
  onDeleteAutomationPoint,
}) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  const [scrollX, setScrollX] = React.useState(0);
  const [drag, setDrag] = React.useState<
    | { type: "seek"; startX: number }
    | { type: "region"; regionId: string; startBeats: number; startX: number }
    | {
        type: "automation";
        pointId: string;
        laneId: string;
        startBeats: number;
        startValue: number;
        startX: number;
        startY: number;
      }
    | null
  >(null);
  const pendingMoveRef = React.useRef<{ regionId: string; start: number } | null>(null);
  const [dragPoint, setDragPoint] = React.useState<{
    pointId: string;
    position: number;
    value: number;
  } | null>(null);

  const sizedTracks = React.useMemo(
    () =>
      tracks.map((t) => ({
        ...t,
        height: Math.max(
          MIN_TRACK_HEIGHT + (t.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
          t.height || MIN_TRACK_HEIGHT,
        ),
      })),
    [tracks],
  );

  const totalHeight = React.useMemo(
    () => HEADER_HEIGHT + RULER_HEIGHT + sizedTracks.reduce((sum, t) => sum + t.height, 0),
    [sizedTracks],
  );

  const regionHeightForTrack = (track: (typeof sizedTracks)[number]) =>
    Math.max(
      MIN_TRACK_HEIGHT - 8,
      track.height - (track.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
    );

  const { width, height, dpr } = useCanvasSize(containerRef);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Reset transform before resizing to avoid compounding scales.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    canvas.width = Math.max(1, width * dpr);
    canvas.height = Math.max(1, (height > 0 ? height : totalHeight) * dpr);
    ctx.scale(dpr, dpr);

    const drawWidth = width;
    const drawHeight = height > 0 ? height : totalHeight;

    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--vsdaw-bg").trim();
    const fg = styles.getPropertyValue("--vsdaw-fg").trim();
    const border = styles.getPropertyValue("--vsdaw-border").trim();
    const active = styles.getPropertyValue("--vsdaw-active-bg").trim();
    const button = styles.getPropertyValue("--vsdaw-button-bg").trim();

    // Background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, drawWidth, drawHeight);

    // Time ruler
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = fg;
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    const beatWidth = BEAT_WIDTH * scale;
    const visibleStart = scrollX / beatWidth;
    const visibleBeats = drawWidth / beatWidth;
    const startBar = Math.max(0, Math.floor(visibleStart / timeSignatureNumerator));
    const endBar = Math.max(0, Math.ceil((visibleStart + visibleBeats) / timeSignatureNumerator));

    for (let bar = startBar; bar <= endBar; bar++) {
      const x = bar * timeSignatureNumerator * beatWidth - scrollX;
      if (x < -beatWidth || x > drawWidth + beatWidth) continue;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, HEADER_HEIGHT + RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(`B${bar + 1}`, x + 4, HEADER_HEIGHT + RULER_HEIGHT / 2);
      for (let beat = 1; beat < timeSignatureNumerator; beat++) {
        const bx = x + beat * beatWidth;
        ctx.beginPath();
        ctx.moveTo(bx, HEADER_HEIGHT + RULER_HEIGHT - 8);
        ctx.lineTo(bx, HEADER_HEIGHT + RULER_HEIGHT);
        ctx.stroke();
      }
    }

    // Loop markers
    const loopXs = [loopStart, loopEnd].map((b) => b * beatWidth - scrollX);
    const loopLeft = Math.min(loopXs[0], loopXs[1]);
    const loopRight = Math.max(loopXs[0], loopXs[1]);
    ctx.fillStyle = button;
    ctx.globalAlpha = 0.15;
    ctx.fillRect(loopLeft, HEADER_HEIGHT + RULER_HEIGHT, loopRight - loopLeft, drawHeight);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = button;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(loopLeft, HEADER_HEIGHT + RULER_HEIGHT);
    ctx.lineTo(loopLeft, drawHeight);
    ctx.moveTo(loopRight, HEADER_HEIGHT + RULER_HEIGHT);
    ctx.lineTo(loopRight, drawHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tracks
    let y = HEADER_HEIGHT + RULER_HEIGHT;
    for (const track of sizedTracks) {
      ctx.fillStyle = track.color;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(0, y, drawWidth, track.height);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(0, y + track.height);
      ctx.lineTo(drawWidth, y + track.height);
      ctx.stroke();

      const regionHeight = regionHeightForTrack(track);
      for (const region of track.regions) {
        const rx = region.start * beatWidth - scrollX;
        const rw = Math.max(4, region.duration * beatWidth);
        if (rx + rw < 0 || rx > drawWidth) continue;
        ctx.fillStyle = region.color || track.color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(rx + 1, y + 4, rw - 2, regionHeight - 8);
        ctx.globalAlpha = 1;
        ctx.fillStyle = fg;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx + 6, y + 4, Math.max(0, rw - 12), regionHeight - 8);
        ctx.clip();
        ctx.fillText(region.name, rx + 6, y + regionHeight / 2);
        ctx.restore();
      }

      // Automation lanes
      let laneY = y + regionHeight;
      for (const lane of track.automationLanes ?? []) {
        ctx.fillStyle = border;
        ctx.globalAlpha = 0.05;
        ctx.fillRect(0, laneY, drawWidth, AUTOMATION_LANE_HEIGHT);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = border;
        ctx.beginPath();
        ctx.moveTo(0, laneY + AUTOMATION_LANE_HEIGHT);
        ctx.lineTo(drawWidth, laneY + AUTOMATION_LANE_HEIGHT);
        ctx.stroke();

        const centerY = laneY + AUTOMATION_LANE_HEIGHT / 2;
        ctx.strokeStyle = track.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const displayPoints = dragPoint
          ? lane.points.map((p) =>
              p.id === dragPoint.pointId
                ? { ...p, position: dragPoint.position, value: dragPoint.value }
                : p,
            )
          : lane.points;
        const sorted = [...displayPoints].sort((a, b) => a.position - b.position);
        if (sorted.length === 0) {
          ctx.moveTo(0, centerY);
          ctx.lineTo(drawWidth, centerY);
        } else {
          for (let i = 0; i < sorted.length - 1; i++) {
            const x0 = sorted[i].position * beatWidth - scrollX;
            const y0 = laneY + AUTOMATION_LANE_HEIGHT - sorted[i].value * AUTOMATION_LANE_HEIGHT;
            const x1 = sorted[i + 1].position * beatWidth - scrollX;
            const x1 = sorted[i + 1].position * beatWidth - scrollX;
            const y1 =
              laneY + AUTOMATION_LANE_HEIGHT - sorted[i + 1].value * AUTOMATION_LANE_HEIGHT;
            if (x1 < 0 || x0 > drawWidth) continue;
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
          }
        }
        ctx.stroke();

        for (const point of sorted) {
          const px = point.position * beatWidth - scrollX;
          const py = laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT;
          if (px < -4 || px > drawWidth + 4) continue;
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        laneY += AUTOMATION_LANE_HEIGHT;
      }

      y += track.height;
    }

    // Playhead
    const px = positionBeats * beatWidth - scrollX;
    ctx.strokeStyle = active || "#007fd4";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, HEADER_HEIGHT + RULER_HEIGHT);
    ctx.lineTo(px, drawHeight);
    ctx.stroke();
  }, [
    sizedTracks,
    positionBeats,
    loopStart,
    loopEnd,
    scale,
    scrollX,
    width,
    height,
    dpr,
    totalHeight,
    timeSignatureNumerator,
    dragPoint,
  ]);

  // Flush pending region move on mouse up (throttle bus traffic).
  const flushPendingMove = React.useCallback(() => {
    if (pendingMoveRef.current) {
      onMoveRegion(pendingMoveRef.current.regionId, pendingMoveRef.current.start);
      pendingMoveRef.current = null;
    }
  }, [onMoveRegion]);

  const findAutomationPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left + scrollX;
    const y = clientY - rect.top;
    let trackY = HEADER_HEIGHT + RULER_HEIGHT;
    for (const track of sizedTracks) {
      const regionHeight = regionHeightForTrack(track);
      let laneY = trackY + regionHeight;
      for (const lane of track.automationLanes ?? []) {
        if (y >= laneY && y < laneY + AUTOMATION_LANE_HEIGHT) {
          for (const point of lane.points) {
            const px = point.position * BEAT_WIDTH * scale;
            const py = laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT;
            const dx = x - px;
            const dy = y - py;
            if (dx * dx + dy * dy <= 36) {
              return { point, lane, laneY };
            }
          }
        }
        laneY += AUTOMATION_LANE_HEIGHT;
      }
      trackY += track.height;
    }
    return undefined;
  };

  const findAutomationLaneAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left + scrollX;
    const y = clientY - rect.top;
    let trackY = HEADER_HEIGHT + RULER_HEIGHT;
    for (const track of sizedTracks) {
      const regionHeight = regionHeightForTrack(track);
      let laneY = trackY + regionHeight;
      for (const lane of track.automationLanes ?? []) {
        if (y >= laneY && y < laneY + AUTOMATION_LANE_HEIGHT) {
          return { lane, laneY, x };
        }
        laneY += AUTOMATION_LANE_HEIGHT;
      }
      trackY += track.height;
    }
    return undefined;
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale((s) => Math.max(0.25, Math.min(4, s - e.deltaY * 0.001)));
    } else {
      setScrollX((x) => Math.max(0, x + e.deltaX));
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollX;
    const beats = x / (BEAT_WIDTH * scale);

    if (e.shiftKey) {
      onSeek(Math.max(0, beats));
      setDrag({ type: "seek", startX: e.clientX });
      return;
    }

    // Hit-test regions
    let y = HEADER_HEIGHT + RULER_HEIGHT;
    for (const track of sizedTracks) {
      const regionHeight = regionHeightForTrack(track);
      if (e.clientY - rect.top >= y && e.clientY - rect.top < y + regionHeight) {
        for (const region of track.regions) {
          const rx = region.start * BEAT_WIDTH * scale;
          const rw = Math.max(4, region.duration * BEAT_WIDTH * scale);
          if (x >= rx && x <= rx + rw) {
            onSelectRegion(region.id);
            setDrag({
              type: "region",
              regionId: region.id,
              startBeats: region.start,
              startX: e.clientX,
            });
            return;
          }
        }
      }
      y += track.height;
    }

    // Hit-test automation points
    const hitPoint = findAutomationPoint(e.clientX, e.clientY);
    if (hitPoint) {
      const { point, lane, laneY } = hitPoint;
      setDrag({
        type: "automation",
        pointId: point.id,
        laneId: lane.id,
        startBeats: point.position,
        startValue: point.value,
        startX: e.clientX,
        startY: laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT,
      });
      return;
    }

    // Click on automation lane adds a point
    const hitLane = findAutomationLaneAt(e.clientX, e.clientY);
    if (hitLane) {
      const { lane, laneY, x: localX } = hitLane;
      const position = Math.max(0, localX / (BEAT_WIDTH * scale));
      const value = Math.max(
        0,
        Math.min(
          1,
          (laneY + AUTOMATION_LANE_HEIGHT - e.clientY + rect.top) / AUTOMATION_LANE_HEIGHT,
        ),
      );
      onAddAutomationPoint?.(lane.id, position, value);
      return;
    }

    onSelectRegion(null);
    onSeek(Math.max(0, beats));
    setDrag({ type: "seek", startX: e.clientX });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    if (drag.type === "seek") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollX;
      const beats = x / (BEAT_WIDTH * scale);
      onSeek(Math.max(0, beats));
    } else if (drag.type === "region") {
      const deltaPixels = e.clientX - drag.startX;
      const deltaBeats = deltaPixels / (BEAT_WIDTH * scale);
      pendingMoveRef.current = {
        regionId: drag.regionId,
        start: Math.max(0, drag.startBeats + deltaBeats),
      };
    } else if (drag.type === "automation") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const deltaPixelsX = e.clientX - drag.startX;
      const deltaPixelsY = e.clientY - rect.top - (drag.startY - rect.top);
      const deltaBeats = deltaPixelsX / (BEAT_WIDTH * scale);
      const deltaValue = -deltaPixelsY / AUTOMATION_LANE_HEIGHT;
      setDragPoint({
        pointId: drag.pointId,
        position: Math.max(0, drag.startBeats + deltaBeats),
        value: Math.max(0, Math.min(1, drag.startValue + deltaValue)),
      });
    }
  };

  const handleMouseUp = () => {
    flushPendingMove();
    if (drag?.type === "automation" && dragPoint) {
      onMoveAutomationPoint?.(dragPoint.pointId, dragPoint.position, dragPoint.value);
    }
    setDragPoint(null);
    setDrag(null);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const hit = findAutomationPoint(e.clientX, e.clientY);
    if (hit) {
      onDeleteAutomationPoint?.(hit.point.id);
    }
  };

  const emptyState = sizedTracks.length === 0 && (
    <output
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--vsdaw-fg)",
        opacity: 0.5,
        fontSize: 12,
        pointerEvents: "none",
      }}
    >
      No tracks to display
    </output>
  );

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      style={{ flex: 1, overflow: "auto", position: "relative" }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Timeline canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={{
          display: "block",
          width: width > 0 ? width : "100%",
          height: Math.max(height, totalHeight),
          cursor: drag ? "grabbing" : "default",
        }}
      />
      {emptyState}
    </div>
  );
};

exec
/bin/zsh -lc "nl -ba src/components/timeline/TimelineCanvas.tsx | sed -n '210,260p'" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
   210	      const regionHeight = regionHeightForTrack(track);
   211	      for (const region of track.regions) {
   212	        const rx = region.start * beatWidth - scrollX;
   213	        const rw = Math.max(4, region.duration * beatWidth);
   214	        if (rx + rw < 0 || rx > drawWidth) continue;
   215	        ctx.fillStyle = region.color || track.color;
   216	        ctx.globalAlpha = 0.85;
   217	        ctx.fillRect(rx + 1, y + 4, rw - 2, regionHeight - 8);
   218	        ctx.globalAlpha = 1;
   219	        ctx.fillStyle = fg;
   220	        ctx.save();
   221	        ctx.beginPath();
   222	        ctx.rect(rx + 6, y + 4, Math.max(0, rw - 12), regionHeight - 8);
   223	        ctx.clip();
   224	        ctx.fillText(region.name, rx + 6, y + regionHeight / 2);
   225	        ctx.restore();
   226	      }
   227	
   228	      // Automation lanes
   229	      let laneY = y + regionHeight;
   230	      for (const lane of track.automationLanes ?? []) {
   231	        ctx.fillStyle = border;
   232	        ctx.globalAlpha = 0.05;
   233	        ctx.fillRect(0, laneY, drawWidth, AUTOMATION_LANE_HEIGHT);
   234	        ctx.globalAlpha = 1;
   235	        ctx.strokeStyle = border;
   236	        ctx.beginPath();
   237	        ctx.moveTo(0, laneY + AUTOMATION_LANE_HEIGHT);
   238	        ctx.lineTo(drawWidth, laneY + AUTOMATION_LANE_HEIGHT);
   239	        ctx.stroke();
   240	
   241	        const centerY = laneY + AUTOMATION_LANE_HEIGHT / 2;
   242	        ctx.strokeStyle = track.color;
   243	        ctx.lineWidth = 1.5;
   244	        ctx.beginPath();
   245	        const displayPoints = dragPoint
   246	          ? lane.points.map((p) =>
   247	              p.id === dragPoint.pointId
   248	                ? { ...p, position: dragPoint.position, value: dragPoint.value }
   249	                : p,
   250	            )
   251	          : lane.points;
   252	        const sorted = [...displayPoints].sort((a, b) => a.position - b.position);
   253	        if (sorted.length === 0) {
   254	          ctx.moveTo(0, centerY);
   255	          ctx.lineTo(drawWidth, centerY);
   256	        } else {
   257	          for (let i = 0; i < sorted.length - 1; i++) {
   258	            const x0 = sorted[i].position * beatWidth - scrollX;
   259	            const y0 = laneY + AUTOMATION_LANE_HEIGHT - sorted[i].value * AUTOMATION_LANE_HEIGHT;
   260	            const x1 = sorted[i + 1].position * beatWidth - scrollX;

exec
/bin/zsh -lc "nl -ba src/components/timeline/TimelineCanvas.tsx | sed -n '260,320p'" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
   260	            const x1 = sorted[i + 1].position * beatWidth - scrollX;
   261	            const y1 =
   262	              laneY + AUTOMATION_LANE_HEIGHT - sorted[i + 1].value * AUTOMATION_LANE_HEIGHT;
   263	            if (x1 < 0 || x0 > drawWidth) continue;
   264	            ctx.moveTo(x0, y0);
   265	            ctx.lineTo(x1, y1);
   266	          }
   267	        }
   268	        ctx.stroke();
   269	
   270	        for (const point of sorted) {
   271	          const px = point.position * beatWidth - scrollX;
   272	          const py = laneY + AUTOMATION_LANE_HEIGHT - point.value * AUTOMATION_LANE_HEIGHT;
   273	          if (px < -4 || px > drawWidth + 4) continue;
   274	          ctx.fillStyle = fg;
   275	          ctx.beginPath();
   276	          ctx.arc(px, py, 3, 0, Math.PI * 2);
   277	          ctx.fill();
   278	        }
   279	        laneY += AUTOMATION_LANE_HEIGHT;
   280	      }
   281	
   282	      y += track.height;
   283	    }
   284	
   285	    // Playhead
   286	    const px = positionBeats * beatWidth - scrollX;
   287	    ctx.strokeStyle = active || "#007fd4";
   288	    ctx.lineWidth = 2;
   289	    ctx.beginPath();
   290	    ctx.moveTo(px, HEADER_HEIGHT + RULER_HEIGHT);
   291	    ctx.lineTo(px, drawHeight);
   292	    ctx.stroke();
   293	  }, [
   294	    sizedTracks,
   295	    positionBeats,
   296	    loopStart,
   297	    loopEnd,
   298	    scale,
   299	    scrollX,
   300	    width,
   301	    height,
   302	    dpr,
   303	    totalHeight,
   304	    timeSignatureNumerator,
   305	    dragPoint,
   306	  ]);
   307	
   308	  // Flush pending region move on mouse up (throttle bus traffic).
   309	  const flushPendingMove = React.useCallback(() => {
   310	    if (pendingMoveRef.current) {
   311	      onMoveRegion(pendingMoveRef.current.regionId, pendingMoveRef.current.start);
   312	      pendingMoveRef.current = null;
   313	    }
   314	  }, [onMoveRegion]);
   315	
   316	  const findAutomationPoint = (clientX: number, clientY: number) => {
   317	    const canvas = canvasRef.current;
   318	    if (!canvas) return undefined;
   319	    const rect = canvas.getBoundingClientRect();
   320	    const x = clientX - rect.left + scrollX;

exec
/bin/zsh -lc "find . -maxdepth 3 -type f | sort | sed -n '1,200p'" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
./.git
./.github/workflows/ci.yml
./.github/workflows/release.yml
./.gitignore
./.husky/pre-commit
./.vscode-test.mjs
./.vscodeignore
./CHANGELOG.md
./CONTRIBUTING.md
./LICENSE
./README.md
./ThirdPartyNotices.txt
./biome.json
./docs/ARCHITECTURE.md
./docs/USAGE.md
./docs/review-data.md
./docs/review-ui.md
./jest.config.cjs
./media/icon.png
./package.json
./plans/ai-assisted.md
./postcss.config.js
./public/views/browser.html
./public/views/graph.html
./public/views/mixer.html
./public/views/pianoRoll.html
./public/views/timeline.html
./reviews/issue-23-475832d.md
./reviews/issue-23-e59fc6b.md
./reviews/issue-6-2f8fe5b.md
./reviews/issue-7-22e4065.md
./scripts/build-engine.mjs
./scripts/build-extension.mjs
./scripts/build-integration-tests.mjs
./scripts/build-views.mjs
./scripts/create-icon.mjs
./scripts/package.mjs
./scripts/smoke.js
./scripts/test-engine-isolated.mjs
./specs/00-overview.md
./specs/000-architecture.md
./specs/01-architecture.md
./specs/02-data-model.md
./specs/03-ui-ux.md
./specs/04-audio-engine.md
./specs/05-extension-host-api.md
./specs/06-testing.md
./specs/07-release.md
./specs/08-piano-roll-editing.md
./specs/09-mixer-routing.md
./specs/10-automation.md
./specs/11-audio-recording.md
./specs/12-arranger-polish.md
./specs/13-plugin-hosting.md
./src/engine/engine.ts
./src/engine/index.html
./src/engine/messageHandlers.ts
./src/engine/node-polyfill.ts
./src/engine/projectAdapter.ts
./src/extension/audioServer.ts
./src/extension/commands.ts
./src/extension/engineTransport.ts
./src/extension/extension.ts
./src/extension/messageRouter.ts
./src/extension/playwrightEngine.ts
./src/extension/projectManager.ts
./src/extension/server.ts
./src/extension/stateProjector.ts
./src/extension/types.ts
./src/extension/undoManager.ts
./src/extension/viewMessageAdapter.ts
./src/shared/automation.ts
./src/shared/bundle.ts
./src/shared/midi.ts
./src/shared/peaks.ts
./src/shared/protocol.ts
./src/shared/schemas.ts
./src/shared/time.ts
./src/views/index.css
./src/views/index.tsx
./tailwind.config.js
./tests/__mocks__/vscode.ts
./tests/integration/extension.test.ts
./tests/integration/saveLoadRoundTrip.test.ts
./tests/integration/smoke.test.ts
./tests/unit/bundle.test.ts
./tests/unit/commands.test.ts
./tests/unit/export.test.ts
./tests/unit/import.test.ts
./tests/unit/messageHandlers.test.ts
./tests/unit/midi.test.ts
./tests/unit/peaks.test.ts
./tests/unit/playwrightEngine.test.ts
./tests/unit/projectRoundTrip.test.ts
./tests/unit/protocol.test.ts
./tests/unit/schemas.test.ts
./tests/unit/stateProjector.test.ts
./tests/unit/time.test.ts
./tests/unit/undoManager.test.ts
./tests/unit/viewMessageAdapter.test.ts
./tsconfig.engine.json
./tsconfig.json
./tsconfig.test.json

exec
/bin/zsh -lc "grep -R \"automation\" -n src tests specs | sed -n '1,240p'" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
src/extension/viewMessageAdapter.ts:201:    case "automation/addLane": {
src/extension/viewMessageAdapter.ts:208:    case "automation/removeLane": {
src/extension/viewMessageAdapter.ts:212:    case "automation/addPoint": {
src/extension/viewMessageAdapter.ts:220:    case "automation/movePoint": {
src/extension/viewMessageAdapter.ts:228:    case "automation/deletePoint": {
src/extension/stateProjector.ts:1:import { AUTOMATION_LANE_HEIGHT } from "../shared/automation.js";
src/extension/stateProjector.ts:213:        this.convertTrack(track, state.regions, state.automationLanes, state.automationPoints),
src/extension/stateProjector.ts:221:    automationLanes: EngineAutomationLaneState[],
src/extension/stateProjector.ts:222:    automationPoints: EngineAutomationPointState[],
src/extension/stateProjector.ts:224:    const lanes = automationLanes.filter((lane) => lane.trackId === track.id);
src/extension/stateProjector.ts:245:      automationLanes: lanes.map((lane) => ({
src/extension/stateProjector.ts:249:        points: automationPoints.filter((point) => point.laneId === lane.id),
src/shared/schemas.ts:61:  automation: z.array(z.unknown()),
src/shared/protocol.ts:135:  AutomationAddLane = "automation.addLane",
src/shared/protocol.ts:136:  AutomationRemoveLane = "automation.removeLane",
src/shared/protocol.ts:137:  AutomationAddPoint = "automation.addPoint",
src/shared/protocol.ts:138:  AutomationMovePoint = "automation.movePoint",
src/shared/protocol.ts:139:  AutomationDeletePoint = "automation.deletePoint",
src/shared/protocol.ts:535:  automationLanes: AutomationLaneState[];
src/shared/protocol.ts:536:  automationPoints: AutomationPointState[];
src/shared/automation.ts:3: * for automation lanes and envelope rendering.
src/shared/automation.ts:6:/** Height in pixels of a single automation lane drawn under a track. */
src/shared/automation.ts:9:/** Default normalized value for an empty automation lane (center line). */
src/shared/bundle.ts:53:    automation: [],
src/components/timeline/TimelineCanvas.tsx:2:import { AUTOMATION_LANE_HEIGHT } from "../../shared/automation.js";
src/components/timeline/TimelineCanvas.tsx:81:        type: "automation";
src/components/timeline/TimelineCanvas.tsx:103:          MIN_TRACK_HEIGHT + (t.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
src/components/timeline/TimelineCanvas.tsx:118:      track.height - (track.automationLanes?.length ?? 0) * AUTOMATION_LANE_HEIGHT,
src/components/timeline/TimelineCanvas.tsx:230:      for (const lane of track.automationLanes ?? []) {
src/components/timeline/TimelineCanvas.tsx:326:      for (const lane of track.automationLanes ?? []) {
src/components/timeline/TimelineCanvas.tsx:355:      for (const lane of track.automationLanes ?? []) {
src/components/timeline/TimelineCanvas.tsx:411:    // Hit-test automation points
src/components/timeline/TimelineCanvas.tsx:416:        type: "automation",
src/components/timeline/TimelineCanvas.tsx:427:    // Click on automation lane adds a point
src/components/timeline/TimelineCanvas.tsx:464:    } else if (drag.type === "automation") {
src/components/timeline/TimelineCanvas.tsx:482:    if (drag?.type === "automation" && dragPoint) {
src/components/timeline/TrackHeader.tsx:440:              track.automationLanes.length > 0 ? "var(--vsdaw-active-bg)" : "transparent",
src/components/timeline/TrackHeader.tsx:441:            color: track.automationLanes.length > 0 ? "var(--vsdaw-button-fg)" : "inherit",
src/components/timeline/TrackHeader.tsx:445:            if (track.automationLanes.length === 0)
src/components/timeline/TrackHeader.tsx:449:            if (track.automationLanes.length === 0)
src/components/timeline/TrackHeader.tsx:567:          {track.automationLanes.length > 0 && (
src/components/timeline/TrackHeader.tsx:572:              {track.automationLanes.map((lane) => (
src/views/shared/types.ts:60:  automationLanes: AutomationLane[];
src/views/shared/types.ts:133:  | { type: "automation/addLane"; trackId: string; target: AutomationTarget }
src/views/shared/types.ts:134:  | { type: "automation/removeLane"; laneId: string }
src/views/shared/types.ts:135:  | { type: "automation/addPoint"; laneId: string; position: number; value: number }
src/views/shared/types.ts:136:  | { type: "automation/movePoint"; pointId: string; position?: number; value?: number }
src/views/shared/types.ts:137:  | { type: "automation/deletePoint"; pointId: string }
src/views/shared/useViewState.ts:128:  const automationActions = {
src/views/shared/useViewState.ts:130:      send({ type: "automation/addLane", trackId, target }),
src/views/shared/useViewState.ts:131:    removeLane: (laneId: string) => send({ type: "automation/removeLane", laneId }),
src/views/shared/useViewState.ts:133:      send({ type: "automation/addPoint", laneId, position, value }),
src/views/shared/useViewState.ts:135:      send({ type: "automation/movePoint", pointId, position, value }),
src/views/shared/useViewState.ts:136:    deletePoint: (pointId: string) => send({ type: "automation/deletePoint", pointId }),
src/views/shared/useViewState.ts:186:    automationActions,
src/views/mixer/main.tsx:25:  automationLanes: [],
src/views/timeline/main.tsx:147:                  onAddAutomationLane={state.automationActions.addLane}
src/views/timeline/main.tsx:148:                  onRemoveAutomationLane={state.automationActions.removeLane}
src/views/timeline/main.tsx:164:                  onAddAutomationPoint={state.automationActions.addPoint}
src/views/timeline/main.tsx:165:                  onMoveAutomationPoint={state.automationActions.movePoint}
src/views/timeline/main.tsx:166:                  onDeleteAutomationPoint={state.automationActions.deletePoint}
src/engine/projectAdapter.ts:46:import { DEFAULT_AUTOMATION_VALUE } from "../shared/automation.js";
src/engine/projectAdapter.ts:93:  private automationLanes = new Map<string, AutomationLaneState>();
src/engine/projectAdapter.ts:94:  private automationPoints = new Map<string, AutomationPointState>();
src/engine/projectAdapter.ts:217:    this.automationLanes.clear();
src/engine/projectAdapter.ts:218:    this.automationPoints.clear();
src/engine/projectAdapter.ts:692:    this.automationLanes.set(laneId, { id: laneId, trackId, target });
src/engine/projectAdapter.ts:698:    const lane = this.automationLanes.get(laneId);
src/engine/projectAdapter.ts:702:    this.automationLanes.delete(laneId);
src/engine/projectAdapter.ts:703:    for (const [id, point] of this.automationPoints) {
src/engine/projectAdapter.ts:705:        this.automationPoints.delete(id);
src/engine/projectAdapter.ts:713:    const lane = this.automationLanes.get(laneId);
src/engine/projectAdapter.ts:718:    this.automationPoints.set(pointId, {
src/engine/projectAdapter.ts:730:    const point = this.automationPoints.get(pointId);
src/engine/projectAdapter.ts:741:    const point = this.automationPoints.get(pointId);
src/engine/projectAdapter.ts:745:    this.automationPoints.delete(pointId);
src/engine/projectAdapter.ts:751:    return Array.from(this.automationPoints.values())
src/engine/projectAdapter.ts:785:    for (const lane of this.automationLanes.values()) {
src/engine/projectAdapter.ts:826:      warn("automation", error instanceof Error ? error.message : String(error));
src/engine/projectAdapter.ts:1218:      automationLanes: Array.from(this.automationLanes.values()),
src/engine/projectAdapter.ts:1219:      automationPoints: Array.from(this.automationPoints.values()),
tests/unit/messageHandlers.test.ts:104:      automationLanes: [],
tests/unit/messageHandlers.test.ts:105:      automationPoints: [],
tests/unit/messageHandlers.test.ts:462:describe("messageHandlers - automation", () => {
tests/unit/viewMessageAdapter.test.ts:277:  describe("automation messages", () => {
tests/unit/viewMessageAdapter.test.ts:278:    test("automation/addLane -> automation.addLane", () => {
tests/unit/viewMessageAdapter.test.ts:280:        type: "automation/addLane",
tests/unit/viewMessageAdapter.test.ts:292:    test("automation/removeLane -> automation.removeLane", () => {
tests/unit/viewMessageAdapter.test.ts:294:        type: "automation/removeLane",
tests/unit/viewMessageAdapter.test.ts:302:    test("automation/addPoint -> automation.addPoint", () => {
tests/unit/viewMessageAdapter.test.ts:304:        type: "automation/addPoint",
tests/unit/viewMessageAdapter.test.ts:314:    test("automation/movePoint -> automation.movePoint", () => {
tests/unit/viewMessageAdapter.test.ts:316:        type: "automation/movePoint",
tests/unit/viewMessageAdapter.test.ts:326:    test("automation/deletePoint -> automation.deletePoint", () => {
tests/unit/viewMessageAdapter.test.ts:328:        type: "automation/deletePoint",
tests/unit/stateProjector.test.ts:46:    automationLanes: [],
tests/unit/stateProjector.test.ts:47:    automationPoints: [],
tests/unit/stateProjector.test.ts:159:  test("broadcasts automation lanes and points with increased track height", () => {
tests/unit/stateProjector.test.ts:177:      automationLanes: [lane],
tests/unit/stateProjector.test.ts:178:      automationPoints: [point],
tests/unit/stateProjector.test.ts:191:    expect(viewTrack.automationLanes).toHaveLength(1);
tests/unit/stateProjector.test.ts:192:    expect(viewTrack.automationLanes[0].id).toBe("lane-1");
tests/unit/stateProjector.test.ts:193:    expect(viewTrack.automationLanes[0].points).toEqual([point]);
specs/10-automation.md:4:Users can draw parameter automation envelopes on the Timeline.
specs/10-automation.md:7:- `automation/addLane` — add lane for a parameter.
specs/10-automation.md:8:- `automation/removeLane` — remove lane.
specs/10-automation.md:9:- `automation/addPoint` / `movePoint` / `deletePoint` — edit envelope.
specs/10-automation.md:12:- Toggle automation lane per track.
specs/02-data-model.md:63:  "automation": [],

exec
/bin/zsh -lc "sed -n '1,320p' src/extension/stateProjector.ts && sed -n '660,760p' src/engine/projectAdapter.ts && sed -n '180,240p' src/extension/viewMessageAdapter.ts && sed -n '130,210p' tests/unit/stateProjector.test.ts" in /private/tmp/vsdaw-issue23
 succeeded in 0ms:
import { AUTOMATION_LANE_HEIGHT } from "../shared/automation.js";
import {
  type AutomationLaneState as EngineAutomationLaneState,
  type AutomationPointState as EngineAutomationPointState,
  type DeviceListItem,
  type RegionState as EngineRegionState,
  type TrackState as EngineTrackState,
  MessageType,
  type ProjectState,
  type TransportState,
} from "../shared/protocol.js";
import { DEFAULT_PPQN, ppqnToBarsBeatsTicks, ppqnToSeconds } from "../shared/time.js";
import type {
  BrowserNode,
  HostMessage,
  SelectionState,
  TimePosition,
  RegionState as ViewRegionState,
  TrackState as ViewTrackState,
} from "../views/shared/types.js";
import type { MessageRouter } from "./messageRouter.js";

const MIN_VOLUME_DB = -120;
const DEFAULT_TRACK_HEIGHT = 48;

export interface ProjectStateProjectorOptions {
  projectId: string;
  router: MessageRouter;
  getProjectName: () => string;
  getSaved: () => boolean;
  throttleMs?: number;
}

function dbToLinear(volumeDb: number): number {
  if (volumeDb <= MIN_VOLUME_DB) return 0;
  return Math.max(0, Math.min(1, 10 ** (volumeDb / 20)));
}

function defaultTrackColor(index: number): string {
  return `hsl(${(index * 47) % 360}, 70%, 50%)`;
}

function regionColor(hue: number): string {
  return `hsl(${hue}, 70%, 50%)`;
}

export class ProjectStateProjector {
  private projectId: string;
  private router: MessageRouter;
  private getProjectName: () => string;
  private getSaved: () => boolean;
  private throttleMs: number;
  private projectState?: ProjectState;
  private lastTransport?: HostMessage & { type: "host/transport" };
  private selection: SelectionState = {};
  private pendingPosition?: number;
  private throttleTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ProjectStateProjectorOptions) {
    this.projectId = options.projectId;
    this.router = options.router;
    this.getProjectName = options.getProjectName;
    this.getSaved = options.getSaved;
    this.throttleMs = options.throttleMs ?? 50;
  }

  dispose(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
  }

  handleStateUpdate(state: ProjectState): void {
    this.projectState = state;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
      this.pendingPosition = undefined;
    }

    const transport = this.buildTransportMessage(state.transport);
    this.lastTransport = transport;
    this.broadcast(transport);

    const tracks = this.buildTracksMessage(state);
    this.broadcast(tracks);
  }

  handleTransportPositionChanged(position: number): void {
    this.pendingPosition = position;
    if (this.throttleTimer) return;

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      const pending = this.pendingPosition;
      this.pendingPosition = undefined;
      if (pending === undefined) return;

      const base = this.lastTransport;
      if (!base) return;

      const timeSignature: [number, number] = [
        base.timeSignature.numerator,
        base.timeSignature.denominator,
      ];
      const updated: HostMessage & { type: "host/transport" } = {
        ...base,
        position: this.buildTimePosition(pending, base.bpm, timeSignature),
      };
      this.lastTransport = updated;
      this.broadcast(updated);
    }, this.throttleMs);
  }

  updateSelection(selection: Partial<SelectionState>): void {
    const next: SelectionState = { ...this.selection };
    if ("trackId" in selection) {
      if (selection.trackId === undefined || selection.trackId === null) {
        next.trackId = undefined;
      } else {
        next.trackId = selection.trackId;
      }
    }
    if ("regionId" in selection) {
      if (selection.regionId === undefined || selection.regionId === null) {
        next.regionId = undefined;
      } else {
        next.regionId = selection.regionId;
      }
    }
    if (selection.noteIds) {
      next.noteIds = selection.noteIds;
    } else if ("noteIds" in selection && selection.noteIds === undefined) {
      next.noteIds = undefined;
    }

    if (selectionEquals(next, this.selection)) return;

    this.selection = next;
    this.broadcast({ type: "host/selection", ...next });
  }

  broadcastProject(): void {
    this.broadcast({
      type: "host/project",
      name: this.getProjectName(),
      saved: this.getSaved(),
    });
  }

  async requestDeviceList(): Promise<void> {
    try {
      const response = await this.router.requestEngine(
        this.projectId,
        MessageType.DeviceList,
        undefined,
        { responseType: MessageType.DeviceList, timeoutMs: 10000 },
      );
      const devices = (response.payload as DeviceListItem[] | undefined) ?? [];
      this.broadcast({ type: "host/browser", root: buildBrowserRoot(devices) });
    } catch (error) {
      console.error("[projector] device list request failed", error);
    }
  }

  private broadcast(message: HostMessage): void {
    this.router.broadcastToViews(this.projectId, message);
  }

  private buildTransportMessage(
    transport: TransportState,
  ): HostMessage & { type: "host/transport" } {
    const timeSignature: [number, number] = [
      transport.timeSignature[0],
      transport.timeSignature[1],
    ];
    return {
      type: "host/transport",
      isPlaying: transport.isPlaying,
      isRecording: transport.isRecording,
      isLooping: transport.isLooping,
      isMetronomeEnabled: false,
      position: this.buildTimePosition(transport.position, transport.bpm, timeSignature),
      bpm: transport.bpm,
      timeSignature: {
        numerator: transport.timeSignature[0],
        denominator: transport.timeSignature[1],
      },
    };
  }

  private buildTimePosition(
    positionPpqn: number,
    bpm: number,
    timeSignature: [number, number],
  ): TimePosition {
    const bbt = ppqnToBarsBeatsTicks(positionPpqn, timeSignature, DEFAULT_PPQN);
    const seconds = ppqnToSeconds(positionPpqn, bpm, DEFAULT_PPQN);
    return {
      bars: bbt.bars,
      beats: bbt.beats,
      ticks: bbt.ticks,
      seconds: Math.round(seconds * 1_000_000) / 1_000_000,
    };
  }

  private buildTracksMessage(state: ProjectState): HostMessage & { type: "host/tracks" } {
    return {
      type: "host/tracks",
      tracks: state.tracks.map((track) =>
        this.convertTrack(track, state.regions, state.automationLanes, state.automationPoints),
      ),
    };
  }

  private convertTrack(
    track: EngineTrackState,
    regions: EngineRegionState[],
    automationLanes: EngineAutomationLaneState[],
    automationPoints: EngineAutomationPointState[],
  ): ViewTrackState {
    const lanes = automationLanes.filter((lane) => lane.trackId === track.id);
    return {
      id: track.id,
      name: track.name,
      color: track.color ?? defaultTrackColor(track.index),
      muted: track.mute,
      soloed: track.solo,
      armed: track.arm,
      volume: dbToLinear(track.volumeDb),
      pan: track.pan,
      height: DEFAULT_TRACK_HEIGHT + lanes.length * AUTOMATION_LANE_HEIGHT,
      inserts: track.inserts.map((insert) => ({
        id: insert.id,
        name: insert.name,
        type: insert.type,
        enabled: insert.enabled,
        index: insert.index,
      })),
      regions: regions
        .filter((region) => region.trackId === track.id)
        .map((region) => this.convertRegion(region)),
      automationLanes: lanes.map((lane) => ({
        id: lane.id,
        trackId: lane.trackId,
        target: lane.target,
        points: automationPoints.filter((point) => point.laneId === lane.id),
      })),
    };
  }

  private convertRegion(region: EngineRegionState): ViewRegionState {
    return {
      id: region.id,
      start: region.position,
      duration: region.duration,
      name: region.name,
      color: regionColor(region.hue),
    };
  }
}

function buildBrowserRoot(devices: DeviceListItem[]): BrowserNode {
  const makeDeviceNode = (device: DeviceListItem): BrowserNode => ({
    id: `dev-${device.id}`,
    name: device.name,
    type: "device",
    device,
  });

  return {
    id: "root",
    name: "Browser",
    type: "folder",
    children: [
      {
        id: "devices",
        name: "Devices",
        type: "folder",
        children: [
          {
            id: "devices-instruments",
            name: "Instruments",
            type: "folder",
            children: devices
              .filter((device) => device.category === "instrument")
              .map(makeDeviceNode),
          },
          {
            id: "devices-audio-effects",
            name: "Audio Effects",
            type: "folder",
            children: devices
              .filter((device) => device.category === "audio-effect")
              .map(makeDeviceNode),
          },
          {
            id: "devices-midi-effects",
            name: "MIDI Effects",
            type: "folder",
            children: devices
              .filter((device) => device.category === "midi-effect")
              .map(makeDeviceNode),
          },
        ],
      },
      {
        id: "workspace",
        name: "Workspace Samples",
        type: "folder",
        children: [],
      },
      {
        id: "project",
        name: "Project Samples",
        type: "folder",
        children: [],
      },
  }

  compTakes(takeRegionIds: string[], activeRegionId: string) {
    const activeTakes = new Set(takeRegionIds);
    for (const id of takeRegionIds) {
      const region = this.resolveRegion(id);
      if (region.box instanceof AudioRegionBox || region.box instanceof NoteRegionBox) {
        region.box.mute.setValue(id !== activeRegionId);
      }
    }
    // Mute any other recorded takes for the same audio units that are not in
    // the active comp set.
    for (const regions of this.takeRegions.values()) {
      for (const region of regions) {
        const id = UUID.toString(region.uuid);
        if (!activeTakes.has(id)) {
          if (region.box instanceof AudioRegionBox || region.box instanceof NoteRegionBox) {
            region.box.mute.setValue(true);
          }
        }
      }
    }
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Automation lanes
  // ---------------------------------------------------------------------------

  addAutomationLane(trackId: string, target: AutomationTarget): string {
    this.resolveAudioUnit(trackId);
    const laneId = UUID.toString(UUID.generate());
    this.automationLanes.set(laneId, { id: laneId, trackId, target });
    this.broadcastState();
    return laneId;
  }

  removeAutomationLane(laneId: string) {
    const lane = this.automationLanes.get(laneId);
    if (!lane) {
      throw new Error(`Automation lane not found: ${laneId}`);
    }
    this.automationLanes.delete(laneId);
    for (const [id, point] of this.automationPoints) {
      if (point.laneId === laneId) {
        this.automationPoints.delete(id);
      }
    }
    this.lastAutomationValues.delete(laneId);
    this.broadcastState();
  }

  addAutomationPoint(laneId: string, position: number, value: number): string {
    const lane = this.automationLanes.get(laneId);
    if (!lane) {
      throw new Error(`Automation lane not found: ${laneId}`);
    }
    const pointId = UUID.toString(UUID.generate());
    this.automationPoints.set(pointId, {
      id: pointId,
      laneId,
      position,
      value: Math.max(0, Math.min(1, value)),
    });
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
    return pointId;
  }

  moveAutomationPoint(pointId: string, position?: number, value?: number) {
    const point = this.automationPoints.get(pointId);
    if (!point) {
      throw new Error(`Automation point not found: ${pointId}`);
    }
    if (position !== undefined) point.position = position;
    if (value !== undefined) point.value = Math.max(0, Math.min(1, value));
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
  }

  deleteAutomationPoint(pointId: string) {
    const point = this.automationPoints.get(pointId);
    if (!point) {
      throw new Error(`Automation point not found: ${pointId}`);
    }
    this.automationPoints.delete(pointId);
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
  }

  private getAutomationPointsForLane(laneId: string): AutomationPointState[] {
    return Array.from(this.automationPoints.values())
      .filter((point) => point.laneId === laneId)
      .sort((a, b) => a.position - b.position);
  }

  private interpolateAutomationValue(laneId: string, position: number): number {
    const points = this.getAutomationPointsForLane(laneId);
    if (points.length === 0) {
      return DEFAULT_AUTOMATION_VALUE;
    }
      return { ...base, type: MessageType.DeviceGetParameters, payload };
    }
    case "device/setParameter": {
      const payload: DeviceParameterPayload = {
        deviceId: message.deviceId,
        parameter: message.parameter,
        value: message.value,
      };
      return { ...base, type: MessageType.DeviceSetParameter, payload };
    }

    // Timeline
    case "timeline/moveRegion": {
      const payload: RegionMovePayload = {
        regionId: message.regionId,
        position: message.start,
      };
      return { ...base, type: MessageType.RegionMove, payload };
    }

    // Automation
    case "automation/addLane": {
      const payload: AutomationAddLanePayload = {
        trackId: message.trackId,
        target: message.target,
      };
      return { ...base, type: MessageType.AutomationAddLane, payload };
    }
    case "automation/removeLane": {
      const payload: AutomationRemoveLanePayload = { laneId: message.laneId };
      return { ...base, type: MessageType.AutomationRemoveLane, payload };
    }
    case "automation/addPoint": {
      const payload: AutomationAddPointPayload = {
        laneId: message.laneId,
        position: message.position,
        value: message.value,
      };
      return { ...base, type: MessageType.AutomationAddPoint, payload };
    }
    case "automation/movePoint": {
      const payload: AutomationMovePointPayload = {
        pointId: message.pointId,
        position: message.position,
        value: message.value,
      };
      return { ...base, type: MessageType.AutomationMovePoint, payload };
    }
    case "automation/deletePoint": {
      const payload: AutomationDeletePointPayload = { pointId: message.pointId };
      return { ...base, type: MessageType.AutomationDeletePoint, payload };
    }

    // Piano roll
    case "pianoRoll/setNoteVelocity": {
      const payload: MidiNoteVelocityPayload = {
        noteId: message.noteId,
        velocity: message.velocity,
      };
      return { ...base, type: MessageType.MidiSetNoteVelocity, payload };
    }

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/tracks");
    expect(tracksCall).toBeDefined();
    if (!tracksCall) throw new Error("tracks message not broadcast");
    const tracks = tracksCall[1] as Extract<HostMessage, { type: "host/tracks" }>;
    expect(tracks.tracks).toHaveLength(1);

    const viewTrack = tracks.tracks[0];
    expect(viewTrack.id).toBe("track-1");
    expect(viewTrack.name).toBe("Drums");
    expect(viewTrack.volume).toBeCloseTo(0.5, 5);
    expect(viewTrack.pan).toBe(-0.5);
    expect(viewTrack.muted).toBe(false);
    expect(viewTrack.soloed).toBe(false);
    expect(viewTrack.armed).toBe(false);
    expect(viewTrack.height).toBe(48);
    expect(viewTrack.color).toMatch(/^hsl\(/);

    expect(viewTrack.regions).toHaveLength(1);
    expect(viewTrack.regions[0]).toMatchObject({
      id: "region-1",
      start: 4,
      duration: 8,
      name: "Loop",
    });
    expect(viewTrack.regions[0].color).toMatch(/^hsl\(/);
  });

  test("broadcasts automation lanes and points with increased track height", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const track = createTrack();
    const lane = {
      id: "lane-1",
      trackId: track.id,
      target: { type: "volume" as const, trackId: track.id },
    };
    const point = { id: "point-1", laneId: "lane-1", position: 2, value: 0.75 };
    const state = createProjectState({
      tracks: [track],
      automationLanes: [lane],
      automationPoints: [point],
    });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/tracks");
    expect(tracksCall).toBeDefined();
    if (!tracksCall) throw new Error("tracks message not broadcast");
    const tracks = tracksCall[1] as Extract<HostMessage, { type: "host/tracks" }>;
    expect(tracks.tracks).toHaveLength(1);

    const viewTrack = tracks.tracks[0];
    expect(viewTrack.height).toBe(48 + 60);
    expect(viewTrack.automationLanes).toHaveLength(1);
    expect(viewTrack.automationLanes[0].id).toBe("lane-1");
    expect(viewTrack.automationLanes[0].points).toEqual([point]);
  });

  test("defaults track color when engine track has none", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const track = createTrack({ color: undefined });
    const state = createProjectState({ tracks: [track] });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => msg.type === "host/tracks") as [

