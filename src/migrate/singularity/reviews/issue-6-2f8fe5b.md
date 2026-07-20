OpenAI Codex v0.142.2
--------
workdir: /Users/user/Projects/vsdaw
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019f096c-05ee-71f0-8a2c-aaa0473157cc
--------
user
commit HEAD
exec
/bin/zsh -lc 'git status --short && git rev-parse --show-toplevel && git log --oneline -1' in /Users/user/Projects/vsdaw
 succeeded in 9112ms:
2026-06-27 16:11:49.102 xcodebuild[80169:10731897]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:49.576 xcodebuild[80169:10731896] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-fxDi84Ar' (errno=Operation not permitted)
2026-06-27 16:11:50.661 xcodebuild[80238:10732149]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:50.847 xcodebuild[80238:10732142] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
?? reviews/
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-ygWhTQTZ' (errno=Operation not permitted)
2026-06-27 16:11:53.020 xcodebuild[80246:10732199]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:53.195 xcodebuild[80246:10732198] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-SS1vbs9s' (errno=Operation not permitted)
2026-06-27 16:11:53.838 xcodebuild[80248:10732231]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:54.022 xcodebuild[80248:10732230] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
/Users/user/Projects/vsdaw
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-9fMnFUlp' (errno=Operation not permitted)
2026-06-27 16:11:55.442 xcodebuild[80253:10732256]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:55.618 xcodebuild[80253:10732255] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-4tWhdKZy' (errno=Operation not permitted)
2026-06-27 16:11:56.265 xcodebuild[80257:10732273]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:11:56.442 xcodebuild[80257:10732272] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
2f8fe5b feat(extension,engine,timeline): audio/MIDI file import (#6)

exec
/bin/zsh -lc 'git diff --stat HEAD''^ HEAD && git diff --name-status HEAD''^ HEAD' in /Users/user/Projects/vsdaw
 succeeded in 4835ms:
2026-06-27 16:12:02.522 xcodebuild[80313:10732497]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:02.698 xcodebuild[80313:10732496] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-1VoVbwHA' (errno=Operation not permitted)
2026-06-27 16:12:03.342 xcodebuild[80321:10732520]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:03.516 xcodebuild[80321:10732519] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
 package.json                           |  12 ++
 src/components/browser/BrowserTree.tsx |  16 +-
 src/components/shared/Toolbar.tsx      | 133 ++++++++++++-
 src/engine/messageHandlers.ts          |  17 ++
 src/extension/commands.ts              |  38 ++++
 src/extension/messageRouter.ts         |  12 +-
 src/extension/projectManager.ts        | 129 ++++++++++++-
 src/extension/types.ts                 |   1 +
 src/extension/viewMessageAdapter.ts    |   2 +
 src/shared/protocol.ts                 |   8 +
 src/views/shared/types.ts              |   2 +
 src/views/shared/useViewState.ts       |   2 +
 src/views/timeline/main.tsx            |   2 +
 tests/__mocks__/vscode.ts              |   1 +
 tests/unit/import.test.ts              | 344 +++++++++++++++++++++++++++++++++
 tests/unit/playwrightEngine.test.ts    |   3 +-
 16 files changed, 705 insertions(+), 17 deletions(-)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-XXgfROPz' (errno=Operation not permitted)
2026-06-27 16:12:04.956 xcodebuild[80325:10732544]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:05.129 xcodebuild[80325:10732543] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-tntQAq5H' (errno=Operation not permitted)
2026-06-27 16:12:05.769 xcodebuild[80328:10732559]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:05.943 xcodebuild[80328:10732556] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
M	package.json
M	src/components/browser/BrowserTree.tsx
M	src/components/shared/Toolbar.tsx
M	src/engine/messageHandlers.ts
M	src/extension/commands.ts
M	src/extension/messageRouter.ts
M	src/extension/projectManager.ts
M	src/extension/types.ts
M	src/extension/viewMessageAdapter.ts
M	src/shared/protocol.ts
M	src/views/shared/types.ts
M	src/views/shared/useViewState.ts
M	src/views/timeline/main.tsx
M	tests/__mocks__/vscode.ts
A	tests/unit/import.test.ts
M	tests/unit/playwrightEngine.test.ts

exec
/bin/zsh -lc 'git diff --find-renames --find-copies HEAD''^ HEAD -- src/extension/projectManager.ts src/extension/commands.ts src/components/shared/Toolbar.tsx src/engine/messageHandlers.ts src/extension/messageRouter.ts src/shared/protocol.ts src/views/timeline/main.tsx package.json' in /Users/user/Projects/vsdaw
 succeeded in 2436ms:
2026-06-27 16:12:10.355 xcodebuild[80911:10733396]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:10.530 xcodebuild[80911:10733395] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-J7Ym0Tl5' (errno=Operation not permitted)
2026-06-27 16:12:11.176 xcodebuild[80915:10733417]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:11.349 xcodebuild[80915:10733416] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/package.json b/package.json
index 584de14..ac09785 100644
--- a/package.json
+++ b/package.json
@@ -29,6 +29,8 @@
     "onCommand:vsdaw.showPianoRoll",
     "onCommand:vsdaw.showBrowser",
     "onCommand:vsdaw.showGraph",
+    "onCommand:vsdaw.importAudio",
+    "onCommand:vsdaw.importMidi",
     "onCommand:vsdaw.export",
     "onCommand:vsdaw.settings",
     "onCommand:vsdaw.engineHealth",
@@ -71,6 +73,16 @@
         "title": "Show Graph",
         "category": "VSDAW"
       },
+      {
+        "command": "vsdaw.importAudio",
+        "title": "Import Audio",
+        "category": "VSDAW"
+      },
+      {
+        "command": "vsdaw.importMidi",
+        "title": "Import MIDI",
+        "category": "VSDAW"
+      },
       {
         "command": "vsdaw.export",
         "title": "Export Audio",
diff --git a/src/components/shared/Toolbar.tsx b/src/components/shared/Toolbar.tsx
index 4ae6f7d..f37afae 100644
--- a/src/components/shared/Toolbar.tsx
+++ b/src/components/shared/Toolbar.tsx
@@ -1,5 +1,15 @@
 import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
-import { Download, LayoutGrid, MoreHorizontal, Plus, Save, Settings } from "lucide-react";
+import {
+  Download,
+  FileAudio,
+  FileMusic,
+  LayoutGrid,
+  MoreHorizontal,
+  Plus,
+  Save,
+  Settings,
+  Upload,
+} from "lucide-react";
 import * as React from "react";
 import type { TimePosition, TimeSignature, ViewName } from "../../views/shared/types.js";
 import { TimeDisplay } from "../transport/TimeDisplay.js";
@@ -27,6 +37,8 @@ export interface ToolbarProps {
   onSetTimeSignature: (timeSignature: TimeSignature) => void;
   onShowView: (view: ViewName) => void;
   onAddTrack?: (trackType: "audio" | "midi" | "bus") => void;
+  onImportAudio?: () => void;
+  onImportMidi?: () => void;
   onSettings: () => void;
   onExport: () => void;
 }
@@ -52,6 +64,8 @@ export const Toolbar: React.FC<ToolbarProps> = ({
   onSetTimeSignature,
   onShowView,
   onAddTrack,
+  onImportAudio,
+  onImportMidi,
   onSettings,
   onExport,
 }) => {
@@ -94,6 +108,10 @@ export const Toolbar: React.FC<ToolbarProps> = ({
 
         {onAddTrack && <AddTrackButton onAddTrack={onAddTrack} />}
 
+        {(onImportAudio || onImportMidi) && (
+          <ImportButton onImportAudio={onImportAudio} onImportMidi={onImportMidi} />
+        )}
+
         <ViewSwitcher active={view.toLowerCase() as ViewName} onChange={onShowView} />
       </div>
 
@@ -176,6 +194,87 @@ export const Toolbar: React.FC<ToolbarProps> = ({
   );
 };
 
+const ImportButton: React.FC<{
+  onImportAudio?: () => void;
+  onImportMidi?: () => void;
+}> = ({ onImportAudio, onImportMidi }) => {
+  const [open, setOpen] = React.useState(false);
+  return (
+    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
+      <DropdownMenu.Trigger asChild>
+        <button
+          type="button"
+          aria-label="Import"
+          aria-haspopup="menu"
+          aria-expanded={open}
+          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded cursor-pointer"
+          style={{
+            border: "1px solid var(--vsdaw-border)",
+            backgroundColor: "var(--vsdaw-button-bg)",
+            color: "var(--vsdaw-button-fg)",
+          }}
+          onMouseEnter={(e) => {
+            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-hover)";
+          }}
+          onMouseLeave={(e) => {
+            e.currentTarget.style.backgroundColor = "var(--vsdaw-button-bg)";
+          }}
+        >
+          <Upload size={14} />
+          Import
+        </button>
+      </DropdownMenu.Trigger>
+      <DropdownMenu.Portal>
+        <DropdownMenu.Content
+          className="rounded z-50 min-w-[160px]"
+          style={{
+            backgroundColor: "var(--vsdaw-panel-bg)",
+            border: "1px solid var(--vsdaw-border)",
+            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
+          }}
+        >
+          {onImportAudio && (
+            <DropdownMenu.Item
+              className="px-3 py-2 text-xs cursor-pointer outline-none"
+              style={{ color: "inherit" }}
+              onSelect={() => onImportAudio()}
+              onMouseEnter={(e) => {
+                e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+              }}
+              onMouseLeave={(e) => {
+                e.currentTarget.style.backgroundColor = "transparent";
+              }}
+            >
+              <span className="inline-flex items-center gap-2">
+                <FileAudio size={14} />
+                Audio
+              </span>
+            </DropdownMenu.Item>
+          )}
+          {onImportMidi && (
+            <DropdownMenu.Item
+              className="px-3 py-2 text-xs cursor-pointer outline-none"
+              style={{ color: "inherit" }}
+              onSelect={() => onImportMidi()}
+              onMouseEnter={(e) => {
+                e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+              }}
+              onMouseLeave={(e) => {
+                e.currentTarget.style.backgroundColor = "transparent";
+              }}
+            >
+              <span className="inline-flex items-center gap-2">
+                <FileMusic size={14} />
+                MIDI
+              </span>
+            </DropdownMenu.Item>
+          )}
+        </DropdownMenu.Content>
+      </DropdownMenu.Portal>
+    </DropdownMenu.Root>
+  );
+};
+
 const AddTrackButton: React.FC<{ onAddTrack: (trackType: "audio" | "midi" | "bus") => void }> = ({
   onAddTrack,
 }) => {
@@ -218,8 +317,12 @@ const AddTrackButton: React.FC<{ onAddTrack: (trackType: "audio" | "midi" | "bus
             className="px-3 py-2 text-xs cursor-pointer outline-none"
             style={{ color: "inherit" }}
             onSelect={() => onAddTrack("audio")}
-            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
+            onMouseEnter={(e) => {
+              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+            }}
+            onMouseLeave={(e) => {
+              e.currentTarget.style.backgroundColor = "transparent";
+            }}
           >
             Audio Track
           </DropdownMenu.Item>
@@ -227,8 +330,12 @@ const AddTrackButton: React.FC<{ onAddTrack: (trackType: "audio" | "midi" | "bus
             className="px-3 py-2 text-xs cursor-pointer outline-none"
             style={{ color: "inherit" }}
             onSelect={() => onAddTrack("midi")}
-            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
+            onMouseEnter={(e) => {
+              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+            }}
+            onMouseLeave={(e) => {
+              e.currentTarget.style.backgroundColor = "transparent";
+            }}
           >
             MIDI Track
           </DropdownMenu.Item>
@@ -236,8 +343,12 @@ const AddTrackButton: React.FC<{ onAddTrack: (trackType: "audio" | "midi" | "bus
             className="px-3 py-2 text-xs cursor-pointer outline-none"
             style={{ color: "inherit" }}
             onSelect={() => onAddTrack("bus")}
-            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
+            onMouseEnter={(e) => {
+              e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+            }}
+            onMouseLeave={(e) => {
+              e.currentTarget.style.backgroundColor = "transparent";
+            }}
           >
             Bus Track
           </DropdownMenu.Item>
@@ -258,8 +369,12 @@ const OverflowItem: React.FC<{
     onClick={onClick}
     className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left bg-transparent border-0 text-inherit cursor-pointer"
     style={{ color: "inherit" }}
-    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
+    onMouseEnter={(e) => {
+      e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+    }}
+    onMouseLeave={(e) => {
+      e.currentTarget.style.backgroundColor = "transparent";
+    }}
   >
     {icon}
     {label}
diff --git a/src/engine/messageHandlers.ts b/src/engine/messageHandlers.ts
index 5e796ae..c8df972 100644
--- a/src/engine/messageHandlers.ts
+++ b/src/engine/messageHandlers.ts
@@ -1,4 +1,5 @@
 import {
+  type AudioImportPayload,
   type DeviceCreatePayload,
   type DeviceIdPayload,
   type DeviceMovePayload,
@@ -474,6 +475,22 @@ function routeMessage(
       return { type: "ok" };
     }
 
+    // Audio import
+    case MessageType.AudioImport: {
+      const opts = p as AudioImportPayload;
+      if (!opts?.data) {
+        return { type: "error", message: "Audio data is required" };
+      }
+      const binary = base64ToArrayBuffer(opts.data);
+      return controller
+        .importAudioFile(binary, opts.name)
+        .then((result) => ({ type: "ok" as const, payload: result }))
+        .catch((error: unknown) => ({
+          type: "error" as const,
+          message: error instanceof Error ? error.message : String(error),
+        }));
+    }
+
     // Peaks
     case MessageType.PeaksGet: {
       const opts = p as PeaksGetPayload;
diff --git a/src/extension/commands.ts b/src/extension/commands.ts
index ca343d2..cc97a77 100644
--- a/src/extension/commands.ts
+++ b/src/extension/commands.ts
@@ -84,6 +84,44 @@ export function registerCommands(deps: CommandDependencies): vscode.Disposable[]
     deps.graphProvider.show(projectId);
   });
 
+  register("vsdaw.importAudio", async () => {
+    const projectId = getActiveProjectId(projectManager);
+    if (!projectId) return;
+
+    const uris = await vscode.window.showOpenDialog({
+      canSelectFiles: true,
+      canSelectFolders: false,
+      canSelectMany: false,
+      filters: {
+        "Audio Files": ["wav", "aiff", "flac", "mp3", "ogg", "m4a"],
+        "All Files": ["*"],
+      },
+      openLabel: "Import Audio",
+    });
+    if (!uris || uris.length === 0) return;
+
+    await projectManager.importAudio(uris[0]);
+  });
+
+  register("vsdaw.importMidi", async () => {
+    const projectId = getActiveProjectId(projectManager);
+    if (!projectId) return;
+
+    const uris = await vscode.window.showOpenDialog({
+      canSelectFiles: true,
+      canSelectFolders: false,
+      canSelectMany: false,
+      filters: {
+        "MIDI Files": ["mid", "midi"],
+        "All Files": ["*"],
+      },
+      openLabel: "Import MIDI",
+    });
+    if (!uris || uris.length === 0) return;
+
+    await projectManager.importMidi(uris[0]);
+  });
+
   register("vsdaw.export", async () => {
     const projectId = getActiveProjectId(projectManager);
     if (!projectId) return;
diff --git a/src/extension/messageRouter.ts b/src/extension/messageRouter.ts
index d3ab345..b0988dc 100644
--- a/src/extension/messageRouter.ts
+++ b/src/extension/messageRouter.ts
@@ -1,4 +1,4 @@
-import type * as vscode from "vscode";
+import * as vscode from "vscode";
 import { MessageSchema, MessageType } from "../shared/protocol.js";
 import type { HostMessage, ViewMessage } from "../views/shared/types.js";
 import type { EngineTransport } from "./engineTransport.js";
@@ -353,6 +353,16 @@ export class MessageRouter implements vscode.Disposable {
       return;
     }
 
+    if (viewMessage.type === "command/importAudio") {
+      void vscode.commands.executeCommand("vsdaw.importAudio");
+      return;
+    }
+
+    if (viewMessage.type === "command/importMidi") {
+      void vscode.commands.executeCommand("vsdaw.importMidi");
+      return;
+    }
+
     const envelope = adaptViewMessage(projectId, viewMessage);
     if (!envelope) {
       const reason = `unsupported view message type: ${viewMessage.type}`;
diff --git a/src/extension/projectManager.ts b/src/extension/projectManager.ts
index 951ecaa..559ee59 100644
--- a/src/extension/projectManager.ts
+++ b/src/extension/projectManager.ts
@@ -4,6 +4,7 @@ import * as os from "node:os";
 import * as path from "node:path";
 import * as vscode from "vscode";
 import { BundleError, createEmptyProject, readBundle, writeBundle } from "../shared/bundle.js";
+import { parseMidiFile } from "../shared/midi.js";
 import {
   MessageType,
   type ProjectLoadPayload,
@@ -160,6 +161,7 @@ export class ProjectManager implements vscode.Disposable {
         isDirty: false,
         isUntitled,
         engineDisposables: [engineTransport, engineDisposable],
+        audioFiles: new Map(),
       };
 
       session.views.set("vsdaw.editor", timelinePanel);
@@ -359,7 +361,7 @@ export class ProjectManager implements vscode.Disposable {
 
       const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
       const projectJson = this.buildProjectJsonForSave(session, targetUri);
-      const bundle = await writeBundle(projectJson, new Map(), engineBin);
+      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
       await this.writeProjectBytes(targetUri, bundle);
       session.projectJson = projectJson;
       session.isDirty = false;
@@ -596,7 +598,7 @@ export class ProjectManager implements vscode.Disposable {
       if (!bytes) return;
       const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
       const projectJson = this.buildProjectJsonForSave(session, session.uri);
-      const bundle = await writeBundle(projectJson, new Map(), engineBin);
+      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
       await fs.writeFile(recoveryPath, bundle);
 
       const metadata: RecoveryMetadata = {
@@ -745,6 +747,124 @@ export class ProjectManager implements vscode.Disposable {
     };
   }
 
+  async importAudio(uri: vscode.Uri, trackId?: string): Promise<void> {
+    const projectId = this.getActiveProjectId();
+    if (!projectId) {
+      throw new Error("No active VSDAW project");
+    }
+    const session = this.sessions.get(projectId);
+    if (!session) {
+      throw new Error(`No session for project ${projectId}`);
+    }
+
+    const fileName = path.basename(uri.fsPath);
+    const bytes = await vscode.workspace.fs.readFile(uri);
+    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
+    session.audioFiles.set(audioFileId, bytes);
+
+    const imported = await this.router.requestEngine(
+      projectId,
+      MessageType.AudioImport,
+      {
+        data: Buffer.from(bytes).toString("base64"),
+        name: fileName,
+      },
+      { responseType: `${MessageType.AudioImport}.ack`, timeoutMs: 60000 },
+    );
+    const sample = (imported.payload as { sampleId: string; sample: unknown }).sample;
+
+    const targetTrackId = trackId ?? (await this.createTrack(projectId, "audio"));
+
+    await this.router.requestEngine(
+      projectId,
+      MessageType.RegionCreateAudio,
+      {
+        trackId: targetTrackId,
+        audioFileId,
+        sample,
+        position: 0,
+        name: fileName,
+      },
+      { responseType: `${MessageType.RegionCreateAudio}.ack`, timeoutMs: 30000 },
+    );
+
+    this.markDirty(projectId);
+  }
+
+  async importMidi(uri: vscode.Uri, trackId?: string): Promise<void> {
+    const projectId = this.getActiveProjectId();
+    if (!projectId) {
+      throw new Error("No active VSDAW project");
+    }
+    const session = this.sessions.get(projectId);
+    if (!session) {
+      throw new Error(`No session for project ${projectId}`);
+    }
+
+    const fileName = path.basename(uri.fsPath);
+    const bytes = await vscode.workspace.fs.readFile(uri);
+    const parsed = parseMidiFile(bytes);
+
+    const targetTrackId = trackId ?? (await this.createTrack(projectId, "midi"));
+
+    const ticksPerQuarter = parsed.ticksPerQuarter || 960;
+    const ppqn = 960;
+    const regionDuration =
+      parsed.notes.length > 0
+        ? Math.max(
+            ...parsed.notes.map((n) =>
+              Math.round((n.tick + n.duration) * (ppqn / ticksPerQuarter)),
+            ),
+          )
+        : ppqn * 4;
+
+    const regionResponse = await this.router.requestEngine(
+      projectId,
+      MessageType.RegionCreateMidi,
+      {
+        trackId: targetTrackId,
+        position: 0,
+        duration: regionDuration,
+        name: fileName,
+      },
+      { responseType: `${MessageType.RegionCreateMidi}.ack`, timeoutMs: 30000 },
+    );
+    const regionId = (regionResponse.payload as { regionId: string }).regionId;
+
+    for (const note of parsed.notes) {
+      const position = Math.round(note.tick * (ppqn / ticksPerQuarter));
+      const duration = Math.max(1, Math.round(note.duration * (ppqn / ticksPerQuarter)));
+      this.queueEngineMessage(session, {
+        projectId,
+        direction: "host-to-engine",
+        type: MessageType.MidiAddNote,
+        payload: {
+          regionId,
+          position,
+          duration,
+          pitch: note.pitch,
+          velocity: note.velocity,
+        },
+      });
+    }
+
+    this.markDirty(projectId);
+  }
+
+  private async createTrack(projectId: string, type: "audio" | "midi"): Promise<string> {
+    const response = await this.router.requestEngine(
+      projectId,
+      MessageType.TrackCreate,
+      { type, name: type === "audio" ? "Audio Track" : "MIDI Track" },
+      { responseType: `${MessageType.TrackCreate}.ack`, timeoutMs: 30000 },
+    );
+    const trackId = (response.payload as { trackId: string }).trackId;
+    if (!trackId) {
+      throw new Error(`Track creation failed for ${type}`);
+    }
+    return trackId;
+  }
+
   updateSessionUri(session: ProjectSession, newUri: vscode.Uri): void {
     this.uriToProjectId.delete(session.uri.toString());
     session.uri = newUri;
@@ -752,6 +872,11 @@ export class ProjectManager implements vscode.Disposable {
   }
 }
 
+function safeAudioFileName(input: string): string {
+  const base = path.basename(input).replace(/[^\w\-. ]+/g, "_");
+  return base || `audio-${Date.now()}.wav`;
+}
+
 export async function createNewProjectUri(
   context: vscode.ExtensionContext,
 ): Promise<vscode.Uri | undefined> {
diff --git a/src/shared/protocol.ts b/src/shared/protocol.ts
index 3a130c3..aaca36e 100644
--- a/src/shared/protocol.ts
+++ b/src/shared/protocol.ts
@@ -143,6 +143,8 @@ export enum MessageType {
 
   PeaksGet = "peaks.get",
 
+  AudioImport = "audio.import",
+
   ExportRender = "export.render",
 
   StateGet = "state.get",
@@ -363,6 +365,12 @@ export interface PeaksGetPayload {
   channel?: number;
 }
 
+export interface AudioImportPayload {
+  data: string;
+  name?: string;
+  bpm?: number;
+}
+
 export interface ExportRenderPayload {
   format: ExportFormat;
   start?: number;
diff --git a/src/views/timeline/main.tsx b/src/views/timeline/main.tsx
index ede1ff0..d7281ab 100644
--- a/src/views/timeline/main.tsx
+++ b/src/views/timeline/main.tsx
@@ -109,6 +109,8 @@ const TimelineView: React.FC = () => {
             onSetTimeSignature={state.transport.setTimeSignature}
             onShowView={state.commands.showView}
             onAddTrack={state.trackActions.createTrack}
+            onImportAudio={state.commands.importAudio}
+            onImportMidi={state.commands.importMidi}
             onSettings={() => state.commands.showView("browser")}
             onExport={state.commands.export}
           />

exec
/bin/zsh -lc 'git diff HEAD''^ HEAD -- src/components/browser/BrowserTree.tsx src/extension/types.ts src/extension/viewMessageAdapter.ts src/views/shared/types.ts src/views/shared/useViewState.ts tests/unit/import.test.ts tests/__mocks__/vscode.ts tests/unit/playwrightEngine.test.ts' in /Users/user/Projects/vsdaw
 succeeded in 2461ms:
2026-06-27 16:12:15.804 xcodebuild[80958:10733599]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:15.978 xcodebuild[80958:10733595] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-iSzY0WK4' (errno=Operation not permitted)
2026-06-27 16:12:16.624 xcodebuild[80963:10733618]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-06-27 16:12:16.798 xcodebuild[80963:10733617] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/src/components/browser/BrowserTree.tsx b/src/components/browser/BrowserTree.tsx
index 177f18a..d51ccbc 100644
--- a/src/components/browser/BrowserTree.tsx
+++ b/src/components/browser/BrowserTree.tsx
@@ -103,10 +103,18 @@ const TreeNode: React.FC<{
           cursor: "pointer",
           outline: "none",
         }}
-        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
-        onFocus={(e) => (e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)")}
-        onBlur={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
+        onMouseEnter={(e) => {
+          e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+        }}
+        onMouseLeave={(e) => {
+          e.currentTarget.style.backgroundColor = "transparent";
+        }}
+        onFocus={(e) => {
+          e.currentTarget.style.backgroundColor = "var(--vsdaw-hover-bg)";
+        }}
+        onBlur={(e) => {
+          e.currentTarget.style.backgroundColor = "transparent";
+        }}
       >
         {hasChildren ? (
           expanded ? (
diff --git a/src/extension/types.ts b/src/extension/types.ts
index 94d5e75..04efefc 100644
--- a/src/extension/types.ts
+++ b/src/extension/types.ts
@@ -19,6 +19,7 @@ export interface ProjectSession {
   projectJson?: ProjectJson;
   lastSnapshot?: unknown;
   engineDisposables?: vscode.Disposable[];
+  audioFiles: Map<string, Uint8Array>;
 }
 
 export interface PendingRequest {
diff --git a/src/extension/viewMessageAdapter.ts b/src/extension/viewMessageAdapter.ts
index 8d0b21a..10af24d 100644
--- a/src/extension/viewMessageAdapter.ts
+++ b/src/extension/viewMessageAdapter.ts
@@ -202,6 +202,8 @@ export function adaptViewMessage(
     case "command/delete":
     case "command/duplicate":
     case "command/export":
+    case "command/importAudio":
+    case "command/importMidi":
     case "command/show":
       return undefined;
 
diff --git a/src/views/shared/types.ts b/src/views/shared/types.ts
index d3f68fd..0f139dc 100644
--- a/src/views/shared/types.ts
+++ b/src/views/shared/types.ts
@@ -100,6 +100,8 @@ export type ViewMessage =
   | { type: "command/delete" }
   | { type: "command/duplicate" }
   | { type: "command/export" }
+  | { type: "command/importAudio" }
+  | { type: "command/importMidi" }
   | { type: "command/show"; view: ViewName };
 
 export interface SelectionState {
diff --git a/src/views/shared/useViewState.ts b/src/views/shared/useViewState.ts
index 67e6623..d0d7900 100644
--- a/src/views/shared/useViewState.ts
+++ b/src/views/shared/useViewState.ts
@@ -124,6 +124,8 @@ export function useViewState(view: ViewName) {
     delete: () => send({ type: "command/delete" }),
     duplicate: () => send({ type: "command/duplicate" }),
     export: () => send({ type: "command/export" }),
+    importAudio: () => send({ type: "command/importAudio" }),
+    importMidi: () => send({ type: "command/importMidi" }),
     showView: (target: ViewName) => send({ type: "command/show", view: target }),
   };
 
diff --git a/tests/__mocks__/vscode.ts b/tests/__mocks__/vscode.ts
index eea64e6..9a1acf4 100644
--- a/tests/__mocks__/vscode.ts
+++ b/tests/__mocks__/vscode.ts
@@ -55,6 +55,7 @@ export const window = {
   showErrorMessage: jest.fn().mockResolvedValue(undefined),
   showInformationMessage: jest.fn().mockResolvedValue(undefined),
   showQuickPick: jest.fn().mockResolvedValue(undefined),
+  showOpenDialog: jest.fn().mockResolvedValue(undefined),
   showSaveDialog: jest.fn().mockResolvedValue(undefined),
   createStatusBarItem: jest.fn(() => ({
     show: jest.fn(),
diff --git a/tests/unit/import.test.ts b/tests/unit/import.test.ts
new file mode 100644
index 0000000..f307357
--- /dev/null
+++ b/tests/unit/import.test.ts
@@ -0,0 +1,344 @@
+import type * as vscode from "vscode";
+import type { MessageRouter } from "../../src/extension/messageRouter.js";
+import type { PlaywrightEngineManager } from "../../src/extension/playwrightEngine.js";
+import { ProjectManager } from "../../src/extension/projectManager.js";
+import { MessageType } from "../../src/shared/protocol.js";
+
+const PROJECT_ID = "project-test";
+const TRACK_ID = "track-1";
+const REGION_ID = "region-1";
+const SAMPLE_ID = "sample-1";
+
+function createMockRouter() {
+  return {
+    requestEngine: jest.fn(),
+    routeToEngine: jest.fn(),
+    broadcastToViews: jest.fn(),
+    routeToViews: jest.fn(),
+    registerEngine: jest.fn(() => ({ dispose: jest.fn() })),
+    unregisterEngine: jest.fn(),
+    registerView: jest.fn(),
+    getViews: jest.fn(() => []),
+  } as unknown as jest.Mocked<
+    Pick<
+      import("../../src/extension/messageRouter.js").MessageRouter,
+      | "requestEngine"
+      | "routeToEngine"
+      | "broadcastToViews"
+      | "routeToViews"
+      | "registerEngine"
+      | "unregisterEngine"
+      | "registerView"
+      | "getViews"
+    >
+  >;
+}
+
+interface TestSession {
+  projectId: string;
+  uri: vscode.Uri;
+  engineReady: boolean;
+  pendingEngineMessages: unknown[];
+  views: Map<string, unknown>;
+  isDirty: boolean;
+  isUntitled: boolean;
+  projectJson?: unknown;
+  audioFiles: Map<string, Uint8Array>;
+}
+
+function getSession(manager: ProjectManager): TestSession {
+  const session = (manager as unknown as { sessions: Map<string, TestSession> }).sessions.get(
+    PROJECT_ID,
+  );
+  if (!session) {
+    throw new Error("Session not found");
+  }
+  return session;
+}
+
+function createProjectManager(router: ReturnType<typeof createMockRouter>): ProjectManager {
+  const outputChannel = {
+    appendLine: jest.fn(),
+    append: jest.fn(),
+    clear: jest.fn(),
+    show: jest.fn(),
+    hide: jest.fn(),
+    dispose: jest.fn(),
+  } as unknown as vscode.OutputChannel;
+
+  const context = {
+    subscriptions: [],
+    globalStorageUri: { fsPath: "/tmp/vsdaw" },
+    storageUri: { fsPath: "/tmp/vsdaw" },
+  } as unknown as vscode.ExtensionContext;
+
+  const manager = new ProjectManager({
+    context,
+    outputChannel,
+    router: router as unknown as MessageRouter,
+    engineManager: {} as unknown as PlaywrightEngineManager,
+  });
+
+  const sessionUri = { toString: () => "file:///test.vsdaw" } as unknown as vscode.Uri;
+  (manager as unknown as { sessions: Map<string, TestSession> }).sessions.set(PROJECT_ID, {
+    projectId: PROJECT_ID,
+    uri: sessionUri,
+    engineReady: true,
+    pendingEngineMessages: [],
+    views: new Map(),
+    isDirty: false,
+    isUntitled: false,
+    projectJson: undefined,
+    audioFiles: new Map(),
+  });
+  (manager as unknown as { activeProjectId: string }).activeProjectId = PROJECT_ID;
+
+  return manager;
+}
+
+function buildMinimalMidi(): Uint8Array {
+  const header = new Uint8Array([
+    0x4d,
+    0x54,
+    0x68,
+    0x64, // MThd
+    0x00,
+    0x00,
+    0x00,
+    0x06, // header length
+    0x00,
+    0x00, // format 0
+    0x00,
+    0x01, // 1 track
+    0x00,
+    0x60, // 96 ppqn
+  ]);
+
+  const trackData = new Uint8Array([
+    0x00,
+    0xff,
+    0x51,
+    0x03,
+    0x07,
+    0xa1,
+    0x20, // set tempo 500000us
+    0x00,
+    0x90,
+    0x3c,
+    0x64, // note on C4 velocity 100
+    0x60,
+    0x80,
+    0x3c,
+    0x00, // note off after 96 ticks
+    0x00,
+    0xff,
+    0x2f,
+    0x00, // end of track
+  ]);
+
+  const trackHeader = new Uint8Array([
+    0x4d,
+    0x54,
+    0x72,
+    0x6b, // MTrk
+    (trackData.length >> 24) & 0xff,
+    (trackData.length >> 16) & 0xff,
+    (trackData.length >> 8) & 0xff,
+    trackData.length & 0xff,
+  ]);
+
+  const result = new Uint8Array(header.length + trackHeader.length + trackData.length);
+  result.set(header, 0);
+  result.set(trackHeader, header.length);
+  result.set(trackData, header.length + trackHeader.length);
+  return result;
+}
+
+describe("ProjectManager import", () => {
+  let router: ReturnType<typeof createMockRouter>;
+  let manager: ProjectManager;
+
+  beforeEach(() => {
+    jest.useFakeTimers();
+    router = createMockRouter();
+    manager = createProjectManager(router);
+
+    router.requestEngine.mockImplementation(async (_projectId, type) => {
+      switch (type) {
+        case MessageType.AudioImport:
+          return {
+            projectId: PROJECT_ID,
+            direction: "engine-to-host",
+            type: `${MessageType.AudioImport}.ack`,
+            payload: {
+              sampleId: SAMPLE_ID,
+              sample: { uuid: SAMPLE_ID, name: "loop.wav", duration: 48000, bpm: 120 },
+            },
+          };
+        case MessageType.TrackCreate:
+          return {
+            projectId: PROJECT_ID,
+            direction: "engine-to-host",
+            type: `${MessageType.TrackCreate}.ack`,
+            payload: { trackId: TRACK_ID },
+          };
+        case MessageType.RegionCreateAudio:
+          return {
+            projectId: PROJECT_ID,
+            direction: "engine-to-host",
+            type: `${MessageType.RegionCreateAudio}.ack`,
+            payload: { regionId: REGION_ID },
+          };
+        case MessageType.RegionCreateMidi:
+          return {
+            projectId: PROJECT_ID,
+            direction: "engine-to-host",
+            type: `${MessageType.RegionCreateMidi}.ack`,
+            payload: { regionId: REGION_ID },
+          };
+        default:
+          throw new Error(`Unexpected engine request: ${type}`);
+      }
+    });
+  });
+
+  afterEach(() => {
+    jest.useRealTimers();
+  });
+
+  test("importAudio reads file, stores it in bundle audioFiles and creates region", async () => {
+    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00]);
+    const uri = {
+      fsPath: "/samples/loop.wav",
+      toString: () => "file:///samples/loop.wav",
+    } as unknown as vscode.Uri;
+
+    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(audioBytes);
+
+    await manager.importAudio(uri);
+
+    const session = getSession(manager);
+    expect(session.audioFiles.has("audio/loop.wav")).toBe(true);
+    expect(session.audioFiles.get("audio/loop.wav")).toEqual(audioBytes);
+
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.AudioImport,
+      expect.objectContaining({
+        data: Buffer.from(audioBytes).toString("base64"),
+        name: "loop.wav",
+      }),
+      expect.anything(),
+    );
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.RegionCreateAudio,
+      expect.objectContaining({
+        trackId: TRACK_ID,
+        audioFileId: "audio/loop.wav",
+        name: "loop.wav",
+      }),
+      expect.anything(),
+    );
+
+    expect(session.isDirty).toBe(true);
+  });
+
+  test("importAudio uses provided trackId without creating a new track", async () => {
+    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
+    const uri = {
+      fsPath: "/samples/loop.wav",
+      toString: () => "file:///samples/loop.wav",
+    } as unknown as vscode.Uri;
+
+    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(audioBytes);
+
+    await manager.importAudio(uri, "existing-track");
+
+    expect(router.requestEngine).not.toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.TrackCreate,
+      expect.anything(),
+      expect.anything(),
+    );
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.RegionCreateAudio,
+      expect.objectContaining({ trackId: "existing-track" }),
+      expect.anything(),
+    );
+  });
+
+  test("importMidi parses file, creates MIDI track and region, and queues notes", async () => {
+    const midiBytes = buildMinimalMidi();
+    const uri = {
+      fsPath: "/samples/lead.mid",
+      toString: () => "file:///samples/lead.mid",
+    } as unknown as vscode.Uri;
+
+    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(midiBytes);
+
+    await manager.importMidi(uri);
+
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.TrackCreate,
+      expect.objectContaining({ type: "midi" }),
+      expect.anything(),
+    );
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.RegionCreateMidi,
+      expect.objectContaining({ trackId: TRACK_ID, duration: 960, name: "lead.mid" }),
+      expect.anything(),
+    );
+
+    expect(router.routeToEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      expect.objectContaining({
+        type: MessageType.MidiAddNote,
+        payload: expect.objectContaining({ regionId: REGION_ID, pitch: 60, velocity: 100 }),
+      }),
+    );
+
+    const session = getSession(manager);
+    expect(session.isDirty).toBe(true);
+  });
+
+  test("importMidi uses provided trackId without creating a new track", async () => {
+    const midiBytes = buildMinimalMidi();
+    const uri = {
+      fsPath: "/samples/lead.mid",
+      toString: () => "file:///samples/lead.mid",
+    } as unknown as vscode.Uri;
+
+    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(midiBytes);
+
+    await manager.importMidi(uri, "existing-midi-track");
+
+    expect(router.requestEngine).not.toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.TrackCreate,
+      expect.anything(),
+      expect.anything(),
+    );
+    expect(router.requestEngine).toHaveBeenCalledWith(
+      PROJECT_ID,
+      MessageType.RegionCreateMidi,
+      expect.objectContaining({ trackId: "existing-midi-track" }),
+      expect.anything(),
+    );
+  });
+
+  test("importAudio throws when there is no active project", async () => {
+    (manager as unknown as { activeProjectId: string | undefined }).activeProjectId = undefined;
+    const uri = { fsPath: "/samples/loop.wav" } as unknown as vscode.Uri;
+    await expect(manager.importAudio(uri)).rejects.toThrow("No active VSDAW project");
+  });
+
+  test("importMidi throws when there is no active project", async () => {
+    (manager as unknown as { activeProjectId: string | undefined }).activeProjectId = undefined;
+    const uri = { fsPath: "/samples/lead.mid" } as unknown as vscode.Uri;
+    await expect(manager.importMidi(uri)).rejects.toThrow("No active VSDAW project");
+  });
+});
diff --git a/tests/unit/playwrightEngine.test.ts b/tests/unit/playwrightEngine.test.ts
index 7f57741..f3b82ef 100644
--- a/tests/unit/playwrightEngine.test.ts
+++ b/tests/unit/playwrightEngine.test.ts
@@ -37,7 +37,8 @@ function createMockPage(): MockPage {
   const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
   return {
     on: jest.fn((_event: string, handler: (...args: unknown[]) => void) => {
-      (handlers[_event] ??= []).push(handler);
+      handlers[_event] ??= [];
+      handlers[_event].push(handler);
     }) as MockPage["on"],
     evaluate: jest.fn().mockResolvedValue(undefined),
     exposeFunction: jest.fn().mockResolvedValue(undefined),

exec
/bin/zsh -lc "sed -n '1,260p' src/shared/bundle.ts && sed -n '1,260p' src/shared/midi.ts && sed -n '1,260p' src/engine/controller.ts 2>/dev/null || true && grep -R \"importAudioFile\\|RegionCreateAudio\\|audioFileId\\|audioFiles\" -n src | head -100" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import JSZip from "jszip";
import { type ProjectJson, projectJsonSchema } from "./schemas.js";

export interface BundleReadResult {
  project: ProjectJson;
  audioFiles: Map<string, Uint8Array>;
  engineBin?: Uint8Array;
}

export interface BundleWriteOptions {
  project: ProjectJson;
  audioFiles?: Map<string, Uint8Array>;
  engineBin?: Uint8Array;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export function createEmptyProject(name = "Untitled", sampleRate = 48000): ProjectJson {
  const now = new Date().toISOString();
  return {
    $schema: "vsdaw://project.json/v1",
    version: "1.0.0",
    createdBy: "vsdaw",
    createdAt: now,
    project: {
      name,
      sampleRate,
      tempo: 120,
      timeSignature: [4, 4],
      loop: { enabled: false, start: 0, end: 0 },
    },
    tracks: [
      {
        id: "track-1",
        name: "Audio 1",
        type: "audio",
        color: "#3b82f6",
        volumeDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        arm: false,
        inserts: [],
      },
    ],
    regions: [],
    midiClips: [],
    automation: [],
    mixer: { masterVolumeDb: 0 },
  };
}

export async function readBundle(data: Uint8Array): Promise<BundleReadResult> {
  if (!(data instanceof Uint8Array)) {
    throw new BundleError("Bundle data must be a Uint8Array");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new BundleError("Failed to parse ZIP archive");
  }

  const projectFile = zip.file("project.json");
  if (!projectFile) {
    throw new BundleError("Missing project.json in bundle");
  }

  const projectText = await projectFile.async("string");
  let project: unknown;
  try {
    project = JSON.parse(projectText);
  } catch {
    throw new BundleError("project.json is not valid JSON");
  }

  const parsed = projectJsonSchema.safeParse(project);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundleError(`project.json validation failed: ${issues}`);
  }

  const audioFiles = new Map<string, Uint8Array>();
  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (relativePath.startsWith("audio/")) {
      const safeName = sanitizeAudioPath(relativePath);
      if (!safeName) continue;
      const buffer = await zipEntry.async("uint8array");
      audioFiles.set(safeName, buffer);
    }
  }

  const engineBinEntry = zip.file("engine.bin");
  const engineBin = engineBinEntry ? await engineBinEntry.async("uint8array") : undefined;

  return { project: parsed.data, audioFiles, engineBin };
}

export async function writeBundle(
  project: ProjectJson,
  audioFiles: Map<string, Uint8Array> = new Map(),
  engineBin?: Uint8Array,
): Promise<Uint8Array> {
  const parsed = projectJsonSchema.safeParse(project);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundleError(`Invalid project data: ${issues}`);
  }

  const zip = new JSZip();
  zip.file("project.json", JSON.stringify(parsed.data, null, 2));

  if (engineBin && engineBin.byteLength > 0) {
    zip.file("engine.bin", engineBin);
  }

  if (audioFiles.size > 0) {
    const audioFolder = zip.folder("audio");
    if (!audioFolder) {
      throw new BundleError("Failed to create audio folder in bundle");
    }
    for (const [relativePath, data] of audioFiles) {
      const name = sanitizeAudioPath(relativePath);
      if (!name) {
        throw new BundleError(`Invalid audio file path: ${relativePath}`);
      }
      audioFolder.file(name.replace(/^audio\//, ""), data);
    }
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * Sanitizes an audio file path so it stays inside the bundle's audio/ folder.
 * Returns a canonical path like "audio/<safe-name>" or undefined if invalid.
 */
function sanitizeAudioPath(input: string): string | undefined {
  if (!input || typeof input !== "string") return undefined;

  // Normalize separators and collapse redundant slashes.
  let normalized = input.replace(/\\/g, "/").replace(/\/+/g, "/").trim();

  // Strip leading "audio/" so we can re-apply it consistently.
  normalized = normalized.replace(/^audio\//, "");

  // Reject path traversal, absolute paths, hidden files, and empty names.
  if (
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.startsWith("/") ||
    normalized.startsWith(".") ||
    normalized.length === 0
  ) {
    return undefined;
  }

  const segments = normalized.split("/");
  if (segments.length !== 1) {
    // Only flat audio files are supported; nested folders are rejected.
    return undefined;
  }

  const fileName = segments[0];
  if (!/^[\w\-. ]+\.\w+$/i.test(fileName)) {
    return undefined;
  }

  return `audio/${fileName}`;
}
export interface MidiNote {
  tick: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface ParsedMidiFile {
  format: number;
  ticksPerQuarter: number;
  tempo: number; // microseconds per quarter note
  notes: MidiNote[];
}

const DEFAULT_TEMPO = 500_000; // 120 BPM

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint24(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]
  );
}

function readVariableLength(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let i = 0;
  while (i < 4) {
    const byte = data[offset + i];
    value = (value << 7) | (byte & 0x7f);
    i++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, length: i };
}

function textDecoder(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("latin1").decode(bytes);
  }
  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  return result;
}

export class MidiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiParseError";
  }
}

export function parseMidiFile(data: Uint8Array): ParsedMidiFile {
  if (data.length < 14 || textDecoder(data.subarray(0, 4)) !== "MThd") {
    throw new MidiParseError("Not a valid MIDI file");
  }

  const headerLength = readUint32(data, 4);
  if (headerLength !== 6) {
    throw new MidiParseError(`Unsupported MIDI header length: ${headerLength}`);
  }

  const format = readUint16(data, 8);
  const trackCount = readUint16(data, 10);
  const division = readUint16(data, 12);

  if ((division & 0x8000) !== 0) {
    throw new MidiParseError("SMPTE timecode division is not supported");
  }

  const ticksPerQuarter = division;
  let tempo = DEFAULT_TEMPO;
  const notes: MidiNote[] = [];

  let offset = 14;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (offset + 8 > data.length) {
      throw new MidiParseError("Truncated MIDI track header");
    }

    const chunkId = textDecoder(data.subarray(offset, offset + 4));
    if (chunkId !== "MTrk") {
      throw new MidiParseError(`Unexpected MIDI chunk: ${chunkId}`);
    }
    const chunkLength = readUint32(data, offset + 4);
    offset += 8;

    if (offset + chunkLength > data.length) {
      throw new MidiParseError("Truncated MIDI track data");
    }

    const trackEnd = offset + chunkLength;
    let tick = 0;
    let runningStatus = 0;
    const activeNotes = new Map<number, { tick: number; velocity: number }>();

    while (offset < trackEnd) {
      const delta = readVariableLength(data, offset);
      offset += delta.length;
      tick += delta.value;

      if (offset >= trackEnd) {
        throw new MidiParseError("Unexpected end of track while reading event status");
      }

      let status = data[offset];

      if (status === 0xff) {
        offset++;
        const metaType = data[offset++];
        const metaLength = readVariableLength(data, offset);
        offset += metaLength.length;

        if (offset + metaLength.value > trackEnd) {
          throw new MidiParseError("Meta event exceeds track bounds");
        }

        if (metaType === 0x2f) {
          offset += metaLength.value;
          if (offset !== trackEnd) {
            offset = trackEnd;
          }
          runningStatus = 0;
          break;
        }

        if (metaType === 0x51 && metaLength.value === 3) {
          tempo = readUint24(data, offset);
        }

        offset += metaLength.value;
        runningStatus = 0;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVariableLength(data, offset + 1);
        offset += 1 + sysexLength.length + sysexLength.value;
        runningStatus = 0;
        continue;
      }

      if (status < 0x80) {
        if (runningStatus === 0) {
          throw new MidiParseError(`Unexpected data byte without running status: ${status}`);
        }
        status = runningStatus;
      } else {
        runningStatus = status;
        offset++;
      }

      const command = status & 0xf0;
      switch (command) {
        case 0x80: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated note-off event");
          const pitch = data[offset++];
          offset++;
          closeNote(activeNotes, notes, pitch, tick);
          break;
        }
        case 0x90: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated note-on event");
          const pitch = data[offset++];
          const velocity = data[offset++];
          if (velocity === 0) {
            closeNote(activeNotes, notes, pitch, tick);
          } else {
            activeNotes.set(pitch, { tick, velocity });
          }
          break;
        }
        case 0xa0:
        case 0xb0: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated MIDI event");
          offset += 2;
          break;
        }
        case 0xc0:
        case 0xd0: {
          offset += 1;
          break;
        }
        case 0xe0: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated pitch-bend event");
          offset += 2;
          break;
        }
        default: {
          throw new MidiParseError(`Unsupported MIDI status: ${status.toString(16)}`);
        }
      }
    }

    for (const [pitch, note] of activeNotes) {
      notes.push({ tick: note.tick, duration: tick - note.tick, pitch, velocity: note.velocity });
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);

  return { format, ticksPerQuarter, tempo, notes };
}

function closeNote(
  activeNotes: Map<number, { tick: number; velocity: number }>,
  notes: MidiNote[],
  pitch: number,
  tick: number,
): void {
  const note = activeNotes.get(pitch);
  if (!note) return;
  activeNotes.delete(pitch);
  notes.push({
    tick: note.tick,
    duration: Math.max(0, tick - note.tick),
    pitch,
    velocity: note.velocity,
  });
}
src/extension/types.ts:22:  audioFiles: Map<string, Uint8Array>;
src/extension/projectManager.ts:164:        audioFiles: new Map(),
src/extension/projectManager.ts:364:      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
src/extension/projectManager.ts:601:      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
src/extension/projectManager.ts:762:    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
src/extension/projectManager.ts:763:    session.audioFiles.set(audioFileId, bytes);
src/extension/projectManager.ts:780:      MessageType.RegionCreateAudio,
src/extension/projectManager.ts:783:        audioFileId,
src/extension/projectManager.ts:788:      { responseType: `${MessageType.RegionCreateAudio}.ack`, timeoutMs: 30000 },
src/shared/protocol.ts:119:  RegionCreateAudio = "region.createAudio",
src/shared/protocol.ts:254:export interface RegionCreateAudioPayload {
src/shared/protocol.ts:256:  audioFileId: string;
src/shared/bundle.ts:6:  audioFiles: Map<string, Uint8Array>;
src/shared/bundle.ts:12:  audioFiles?: Map<string, Uint8Array>;
src/shared/bundle.ts:89:  const audioFiles = new Map<string, Uint8Array>();
src/shared/bundle.ts:96:      audioFiles.set(safeName, buffer);
src/shared/bundle.ts:103:  return { project: parsed.data, audioFiles, engineBin };
src/shared/bundle.ts:108:  audioFiles: Map<string, Uint8Array> = new Map(),
src/shared/bundle.ts:124:  if (audioFiles.size > 0) {
src/shared/bundle.ts:129:    for (const [relativePath, data] of audioFiles) {
src/engine/projectAdapter.ts:392:  async importAudioFile(
src/engine/messageHandlers.ts:22:  type RegionCreateAudioPayload,
src/engine/messageHandlers.ts:263:    case MessageType.RegionCreateAudio: {
src/engine/messageHandlers.ts:264:      const opts = p as RegionCreateAudioPayload;
src/engine/messageHandlers.ts:271:        uuid: opts.audioFileId,
src/engine/messageHandlers.ts:486:        .importAudioFile(binary, opts.name)

exec
/bin/zsh -lc "sed -n '1,220p' src/extension/projectManager.ts && sed -n '220,520p' src/extension/projectManager.ts && sed -n '520,760p' src/extension/projectManager.ts && sed -n '760,920p' src/extension/projectManager.ts" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BundleError, createEmptyProject, readBundle, writeBundle } from "../shared/bundle.js";
import { parseMidiFile } from "../shared/midi.js";
import {
  MessageType,
  type ProjectLoadPayload,
  type ProjectNewPayload,
  type ProjectState,
} from "../shared/protocol.js";
import type { ProjectJson } from "../shared/schemas.js";
import { acquireServer, releaseServer } from "./audioServer.js";
import type { MessageRouter } from "./messageRouter.js";
import type { PlaywrightEngineManager } from "./playwrightEngine.js";
import { ProjectStateProjector } from "./stateProjector.js";
import type { MessageEnvelope, ProjectSession } from "./types.js";

export interface ProjectManagerOptions {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  router: MessageRouter;
  engineManager: PlaywrightEngineManager;
}

interface RecoveryMetadata {
  originalUri: string;
  recoveredAt: string;
  projectName: string;
}

const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BACKUP_INTERVAL_MS = 60000;

export class ProjectManager implements vscode.Disposable {
  private sessions = new Map<string, ProjectSession>();
  private projectors = new Map<string, ProjectStateProjector>();
  private uriToProjectId = new Map<string, string>();
  private activeProjectId: string | undefined;
  private serverOrigin: string | undefined;
  private _onDidChangeProject = new vscode.EventEmitter<string>();
  public readonly onDidChangeProject = this._onDidChangeProject.event;

  constructor(private options: ProjectManagerOptions) {}

  dispose(): void {
    this._onDidChangeProject.dispose();
  }

  get context(): vscode.ExtensionContext {
    return this.options.context;
  }

  get router(): MessageRouter {
    return this.options.router;
  }

  get outputChannel(): vscode.OutputChannel {
    return this.options.outputChannel;
  }

  getServerOrigin(): string | undefined {
    return this.serverOrigin;
  }

  getActiveProjectId(): string | undefined {
    return this.activeProjectId;
  }

  setActiveProjectId(projectId: string | undefined): void {
    this.activeProjectId = projectId;
  }

  getSession(projectId: string): ProjectSession | undefined {
    return this.sessions.get(projectId);
  }

  getSessionByUri(uri: vscode.Uri): ProjectSession | undefined {
    const projectId = this.uriToProjectId.get(uri.toString());
    return projectId ? this.sessions.get(projectId) : undefined;
  }

  async initialize(): Promise<void> {
    await this.offerRecovery();
  }

  async newProject(): Promise<void> {
    const uri = await createNewProjectUri(this.context);
    if (!uri) return;

    await writeEmptyProject(uri);
    await openProjectFile(uri);
  }

  async openProject(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "VSDAW Project": ["vsdaw"] },
      openLabel: "Open Project",
    });
    if (!uris || uris.length === 0) return;
    await openProjectFile(uris[0]);
  }

  async ensureProjectForDocument(
    uri: vscode.Uri,
    timelinePanel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
  ): Promise<ProjectSession> {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const existing = this.getSessionByUri(uri);
    if (existing) {
      existing.views.set("vsdaw.editor", timelinePanel);
      this.router.registerView(existing.projectId, timelinePanel);
      this.activeProjectId = existing.projectId;
      return existing;
    }

    return this.createSession(uri, timelinePanel, token);
  }

  private async createSession(
    uri: vscode.Uri,
    timelinePanel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
  ): Promise<ProjectSession> {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const port = await acquireServer(this.context);
    if (token?.isCancellationRequested) {
      await releaseServer();
      throw new vscode.CancellationError();
    }
    this.serverOrigin = `http://127.0.0.1:${port}`;

    const projectId = crypto.randomUUID();
    const isUntitled = uri.scheme !== "file";
    const cleanupDisposables: vscode.Disposable[] = [];

    try {
      const origin = this.serverOrigin ?? `http://127.0.0.1:${port}`;
      const engineTransport = await this.options.engineManager.createEngine(projectId, origin);
      const engineDisposable = this.router.registerEngine(projectId, engineTransport);
      cleanupDisposables.push(engineTransport, engineDisposable);

      const session: ProjectSession = {
        projectId,
        uri,
        engineReady: false,
        pendingEngineMessages: [],
        views: new Map(),
        isDirty: false,
        isUntitled,
        engineDisposables: [engineTransport, engineDisposable],
        audioFiles: new Map(),
      };

      session.views.set("vsdaw.editor", timelinePanel);
      this.router.registerView(projectId, timelinePanel);

      this.sessions.set(projectId, session);
      this.uriToProjectId.set(uri.toString(), projectId);
      this.activeProjectId = projectId;

      const projector = new ProjectStateProjector({
        projectId,
        router: this.router,
        getProjectName: () => this.getSessionProjectName(session),
        getSaved: () => !session.isDirty,
      });
      this.projectors.set(projectId, projector);

      cleanupDisposables.push(
        engineTransport.onDidDispose(() => {
          if (!this.sessions.has(projectId)) return;
          this.outputChannel.appendLine(
            `[project] engine transport closed for ${projectId}, closing session`,
          );
          this.closeProject(projectId).catch(() => {
            // ignore
          });
        }),
      );

      cleanupDisposables.push(
        timelinePanel.onDidDispose(() => {
          this.closeProject(projectId).catch(() => {
            // ignore
          });
        }),
      );

      if (uri.scheme === "file") {
        try {
          await this.loadProjectIntoSession(session, token);
        } catch (error) {
          if (error instanceof vscode.CancellationError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.outputChannel.appendLine(`[project] failed to load ${uri.fsPath}: ${message}`);
          vscode.window.showWarningMessage(
            `VSDAW could not load existing project data: ${message}`,
          );
        }
      }

      // Cleanup disposables are now owned by the session lifecycle.
      cleanupDisposables.length = 0;
      return session;
    } catch (error) {
      for (const d of cleanupDisposables) {
        try {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      this.sessions.delete(projectId);
      this.uriToProjectId.delete(uri.toString());
      if (this.activeProjectId === projectId) {
        this.activeProjectId = undefined;
      }
      await releaseServer();
      if (this.sessions.size === 0) {
        this.serverOrigin = undefined;
      }
      throw error;
    }
  }

  async closeProject(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || session.isClosing) return;
    session.isClosing = true;

    this.projectors.get(projectId)?.dispose();
    this.projectors.delete(projectId);

    this.clearAutoSave(session);
    this.router.unregisterEngine(projectId);
    session.pendingEngineMessages = [];

    if (session.engineDisposables) {
      for (const d of session.engineDisposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      session.engineDisposables = undefined;
    }

    for (const [, panel] of session.views) {
      try {
        panel.dispose();
      } catch {
        // ignore
      }
    }

    this.sessions.delete(projectId);
    this.uriToProjectId.delete(session.uri.toString());
    if (this.activeProjectId === projectId) {
      this.activeProjectId = undefined;
    }

    if (this.sessions.size === 0) {
      await releaseServer();
      this.serverOrigin = undefined;
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.closeProject(id);
    }
  }

  async saveProject(projectId: string, token?: vscode.CancellationToken): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }
    await this.saveSession(session, token);
  }

  async saveProjectByUri(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
    const session = this.getSessionByUri(uri);
    if (!session) {
      throw new Error(`No project session for ${uri.toString()}`);
    }
    await this.saveSession(session, token);
  }

  async saveProjectAs(
    projectId: string,
    destination: vscode.Uri,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;

    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    this.updateSessionUri(session, destination);
    session.isUntitled = false;

    await this.saveSession(session, token);
  }

  private async saveSession(
    session: ProjectSession,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;

    if (session.isSaving) {
      // A save is already in progress; do not queue overlapping saves.
      return;
    }

    let targetUri = session.uri;
    if (session.isUntitled) {
      const picked = await vscode.window.showSaveDialog({
        defaultUri: targetUri,
        filters: { "VSDAW Project": ["vsdaw"] },
        saveLabel: "Save Project",
      });
      if (!picked) return;
      if (token?.isCancellationRequested) return;
      this.updateSessionUri(session, picked);
      session.isUntitled = false;
      targetUri = picked;
    }

    session.isSaving = true;
    try {
      const response = await this.router.requestEngine(
        session.projectId,
        MessageType.ProjectSave,
        { format: "arraybuffer" },
        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
      );
      if (token?.isCancellationRequested) return;
      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
      if (!bytes) {
        throw new Error("Engine returned empty project data");
      }

      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      const projectJson = this.buildProjectJsonForSave(session, targetUri);
      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
      await this.writeProjectBytes(targetUri, bundle);
      session.projectJson = projectJson;
      session.isDirty = false;
      this.updateSaveIndicator(session);
      this.projectors.get(session.projectId)?.broadcastProject();
      this.outputChannel.appendLine(`[project] saved ${targetUri.fsPath}`);
    } finally {
      session.isSaving = false;
    }
  }

  markDirty(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.isClosing) return;
    const becameDirty = !session.isDirty;
    session.isDirty = true;
    if (becameDirty) {
      this._onDidChangeProject.fire(projectId);
      this.projectors.get(projectId)?.broadcastProject();
    }
    this.updateSaveIndicator(session);
    this.scheduleAutoSave(session);
  }

  onEngineReady(projectId: string, payload: unknown): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.engineReady = true;
    this.outputChannel.appendLine(
      `[project] engine ready for ${projectId}: ${JSON.stringify(payload)}`,
    );

    for (const queued of session.pendingEngineMessages) {
      this.router.routeToEngine(projectId, queued);
    }
    session.pendingEngineMessages = [];

    this.projectors.get(projectId)?.broadcastProject();
    this.requestEngineStateDump(projectId);
  }

  onEngineError(projectId: string, payload: unknown): void {
    this.outputChannel.appendLine(
      `[project] engine error for ${projectId}: ${JSON.stringify(payload)}`,
    );
    vscode.window.showErrorMessage(`VSDAW engine error: ${JSON.stringify(payload)}`);
  }

  onViewMessage(projectId: string, _message: MessageEnvelope): void {
    this.markDirty(projectId);
  }

  onEngineStateUpdate(projectId: string, message: MessageEnvelope): void {
    const projector = this.projectors.get(projectId);
    if (!projector) return;

    if (message.type === MessageType.StateUpdate) {
      projector.handleStateUpdate(message.payload as ProjectState);
    } else if (message.type === MessageType.TransportPositionChanged) {
      const position = (message.payload as { position?: number }).position ?? 0;
      projector.handleTransportPositionChanged(position);
    }
  }

  onViewSelection(projectId: string, regionId: string | null): void {
    this.projectors.get(projectId)?.updateSelection({
      regionId: regionId ?? undefined,
    });
  }

  private async requestEngineStateDump(projectId: string): Promise<void> {
    try {
      const response = await this.router.requestEngine(projectId, MessageType.StateGet, undefined, {
        responseType: `${MessageType.StateGet}.result`,
        timeoutMs: 10000,
      });
      this.projectors.get(projectId)?.handleStateUpdate(response.payload as ProjectState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[project] state dump failed: ${message}`);
    }
  }

  private getSessionProjectName(session: ProjectSession): string {
    if (session.projectJson?.project.name) {
      return session.projectJson.project.name;
    }
    return path.basename(session.uri.fsPath, ".vsdaw") || "Untitled";
  }

  private scheduleAutoSave(session: ProjectSession): void {
    this.clearAutoSaveTimer(session);
    const config = vscode.workspace.getConfiguration("vsdaw");
    if (!config.get<boolean>("autoSave", true)) return;

    const delay = config.get<number>("autoSaveDelay", 500);
    if (!Number.isFinite(delay) || delay < 0) {
      this.outputChannel.appendLine("[autosave] invalid autoSaveDelay; skipping");
      return;
    }

    session.autoSaveTimer = setTimeout(() => {
      this.saveProject(session.projectId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[autosave] failed: ${message}`);
      });
    }, delay);

    this.scheduleBackup(session);
  }

  private scheduleBackup(session: ProjectSession): void {
    if (session.backupTimer) return;
    session.backupTimer = setInterval(() => {
      this.writeRecoveryBackup(session).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[backup] failed: ${message}`);
      });
    }, BACKUP_INTERVAL_MS);
  }

  private clearAutoSave(session: ProjectSession): void {
    this.clearAutoSaveTimer(session);
    if (session.backupTimer) {
      clearInterval(session.backupTimer);
      session.backupTimer = undefined;
    }
  }

  private clearAutoSaveTimer(session: ProjectSession): void {
    if (session.autoSaveTimer) {
      clearTimeout(session.autoSaveTimer);
      session.autoSaveTimer = undefined;
    }
  }

  private async writeProjectBytes(uri: vscode.Uri, data: Uint8Array): Promise<void> {
    if (uri.scheme === "file") {
      const tempPath = `${uri.fsPath}.tmp-${Date.now()}`;
      const tempUri = vscode.Uri.file(tempPath);
      try {
        await vscode.workspace.fs.writeFile(tempUri, data);
        await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
      } catch (error) {
        // Best-effort cleanup of the temporary file.
        try {
          await vscode.workspace.fs.delete(tempUri);
        } catch {
          // ignore
        }
        throw error;
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, data);
    }
  }
  }

  private async loadProjectIntoSession(
    session: ProjectSession,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;
    const data = await vscode.workspace.fs.readFile(session.uri);
    if (token?.isCancellationRequested) return;

    let bundle: Awaited<ReturnType<typeof readBundle>>;
    try {
      bundle = await readBundle(new Uint8Array(data));
    } catch (error) {
      if (error instanceof BundleError) {
        throw error;
      }
      throw new BundleError(
        `Failed to read bundle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    session.projectJson = bundle.project;

    if (bundle.engineBin && bundle.engineBin.byteLength > 0) {
      const payload: ProjectLoadPayload = {
        data: Buffer.from(bundle.engineBin).toString("base64"),
      };
      const loadMessage: MessageEnvelope = {
        projectId: session.projectId,
        direction: "host-to-engine",
        type: MessageType.ProjectLoad,
        payload,
      };
      this.queueEngineMessage(session, loadMessage);
    } else {
      // Empty/new project bundle: ask the engine to create a matching empty project.
      const payload: ProjectNewPayload = {
        bpm: bundle.project.project.tempo,
        timeSignature: bundle.project.project.timeSignature,
      };
      const newMessage: MessageEnvelope = {
        projectId: session.projectId,
        direction: "host-to-engine",
        type: MessageType.ProjectNew,
        payload,
      };
      this.queueEngineMessage(session, newMessage);
    }
  }

  private queueEngineMessage(session: ProjectSession, message: MessageEnvelope): void {
    if (session.engineReady) {
      this.router.routeToEngine(session.projectId, message);
    } else {
      session.pendingEngineMessages.push(message);
    }
  }

  private async writeRecoveryBackup(session: ProjectSession): Promise<void> {
    if (session.isSaving) {
      // Avoid racing with an active save operation.
      return;
    }

    const recoveryDir = this.getRecoveryDir();
    await fs.mkdir(recoveryDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryPath = path.join(recoveryDir, `${session.projectId}-${timestamp}.vsdaw`);

    try {
      const response = await this.router.requestEngine(
        session.projectId,
        MessageType.ProjectSave,
        { format: "arraybuffer" },
        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
      );
      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
      if (!bytes) return;
      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      const projectJson = this.buildProjectJsonForSave(session, session.uri);
      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
      await fs.writeFile(recoveryPath, bundle);

      const metadata: RecoveryMetadata = {
        originalUri: session.uri.toString(),
        recoveredAt: new Date().toISOString(),
        projectName: projectJson.project.name,
      };
      await fs.writeFile(
        path.join(recoveryDir, `${session.projectId}-${timestamp}.json`),
        JSON.stringify(metadata, null, 2),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[recovery] backup skipped: ${message}`);
    }
  }

  private async offerRecovery(): Promise<void> {
    const recoveryDir = this.getRecoveryDir();
    let files: string[] = [];
    try {
      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
    } catch {
      return;
    }
    if (files.length === 0) return;

    await this.cleanupStaleRecoveryFiles(recoveryDir, files);

    // Re-read after cleanup.
    try {
      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
    } catch {
      return;
    }
    if (files.length === 0) return;

    const items = await Promise.all(
      files.map(async (fileName) => {
        const metaPath = path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json"));
        let metadata: RecoveryMetadata | undefined;
        try {
          const text = await fs.readFile(metaPath, "utf-8");
          metadata = JSON.parse(text) as RecoveryMetadata;
        } catch {
          // ignore missing/invalid metadata
        }
        const label = metadata ? `${metadata.projectName} (${fileName})` : fileName;
        return { fileName, label, metadata };
      }),
    );

    const selected = await vscode.window.showWarningMessage(
      `VSDAW found ${items.length} recovery file(s). Select a project to restore.`,
      { modal: false },
      ...items.map((i) => i.label),
    );

    if (!selected) return;

    const item = items.find((i) => i.label === selected);
    if (!item) return;

    await this.restoreRecoveryFile(recoveryDir, item.fileName, item.metadata);
  }

  private async cleanupStaleRecoveryFiles(recoveryDir: string, fileNames: string[]): Promise<void> {
    const now = Date.now();
    for (const fileName of fileNames) {
      const filePath = path.join(recoveryDir, fileName);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > RECOVERY_MAX_AGE_MS) {
          await fs.unlink(filePath);
          try {
            await fs.unlink(path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json")));
          } catch {
            // ignore missing metadata
          }
        }
      } catch {
        // ignore stat failures
      }
    }
  }

  private async restoreRecoveryFile(
    recoveryDir: string,
    fileName: string,
    metadata: RecoveryMetadata | undefined,
  ): Promise<void> {
    const recoveryPath = path.join(recoveryDir, fileName);
    const defaultUri = metadata?.originalUri
      ? vscode.Uri.parse(metadata.originalUri)
      : vscode.Uri.file(path.join(os.homedir(), fileName));

    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "VSDAW Project": ["vsdaw"] },
      saveLabel: "Restore Project",
    });

    if (!destination) return;

    try {
      await fs.copyFile(recoveryPath, destination.fsPath);
      await fs.unlink(recoveryPath);
      try {
        await fs.unlink(path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json")));
      } catch {
        // ignore missing metadata
      }
      this.outputChannel.appendLine(`[recovery] restored ${destination.fsPath}`);
      vscode.window.showInformationMessage(`VSDAW restored project to ${destination.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[recovery] restore failed: ${message}`);
      vscode.window.showErrorMessage(`VSDAW could not restore project: ${message}`);
    }
  }

  private getRecoveryDir(): string {
    const base =
      this.context.storageUri?.fsPath ??
      path.join(this.context.globalStorageUri.fsPath, "workspace");
    return path.join(base, ".vsdaw", ".recovery");
  }

  private updateSaveIndicator(session: ProjectSession): void {
    const timeline = session.views.get("vsdaw.editor");
    if (timeline) {
      timeline.title = session.isDirty
        ? `Timeline (${session.projectId.slice(0, 8)}) •`
        : `Timeline (${session.projectId.slice(0, 8)})`;
    }
  }

  private buildProjectJsonForSave(session: ProjectSession, targetUri: vscode.Uri): ProjectJson {
    const base = session.projectJson ?? createEmptyProject("Untitled", 48000);
    return {
      ...base,
      project: {
        ...base.project,
        name: path.basename(targetUri.fsPath, ".vsdaw"),
      },
    };
  }

  async importAudio(uri: vscode.Uri, trackId?: string): Promise<void> {
    const projectId = this.getActiveProjectId();
    if (!projectId) {
      throw new Error("No active VSDAW project");
    }
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    const fileName = path.basename(uri.fsPath);
    const fileName = path.basename(uri.fsPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
    session.audioFiles.set(audioFileId, bytes);

    const imported = await this.router.requestEngine(
      projectId,
      MessageType.AudioImport,
      {
        data: Buffer.from(bytes).toString("base64"),
        name: fileName,
      },
      { responseType: `${MessageType.AudioImport}.ack`, timeoutMs: 60000 },
    );
    const sample = (imported.payload as { sampleId: string; sample: unknown }).sample;

    const targetTrackId = trackId ?? (await this.createTrack(projectId, "audio"));

    await this.router.requestEngine(
      projectId,
      MessageType.RegionCreateAudio,
      {
        trackId: targetTrackId,
        audioFileId,
        sample,
        position: 0,
        name: fileName,
      },
      { responseType: `${MessageType.RegionCreateAudio}.ack`, timeoutMs: 30000 },
    );

    this.markDirty(projectId);
  }

  async importMidi(uri: vscode.Uri, trackId?: string): Promise<void> {
    const projectId = this.getActiveProjectId();
    if (!projectId) {
      throw new Error("No active VSDAW project");
    }
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    const fileName = path.basename(uri.fsPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = parseMidiFile(bytes);

    const targetTrackId = trackId ?? (await this.createTrack(projectId, "midi"));

    const ticksPerQuarter = parsed.ticksPerQuarter || 960;
    const ppqn = 960;
    const regionDuration =
      parsed.notes.length > 0
        ? Math.max(
            ...parsed.notes.map((n) =>
              Math.round((n.tick + n.duration) * (ppqn / ticksPerQuarter)),
            ),
          )
        : ppqn * 4;

    const regionResponse = await this.router.requestEngine(
      projectId,
      MessageType.RegionCreateMidi,
      {
        trackId: targetTrackId,
        position: 0,
        duration: regionDuration,
        name: fileName,
      },
      { responseType: `${MessageType.RegionCreateMidi}.ack`, timeoutMs: 30000 },
    );
    const regionId = (regionResponse.payload as { regionId: string }).regionId;

    for (const note of parsed.notes) {
      const position = Math.round(note.tick * (ppqn / ticksPerQuarter));
      const duration = Math.max(1, Math.round(note.duration * (ppqn / ticksPerQuarter)));
      this.queueEngineMessage(session, {
        projectId,
        direction: "host-to-engine",
        type: MessageType.MidiAddNote,
        payload: {
          regionId,
          position,
          duration,
          pitch: note.pitch,
          velocity: note.velocity,
        },
      });
    }

    this.markDirty(projectId);
  }

  private async createTrack(projectId: string, type: "audio" | "midi"): Promise<string> {
    const response = await this.router.requestEngine(
      projectId,
      MessageType.TrackCreate,
      { type, name: type === "audio" ? "Audio Track" : "MIDI Track" },
      { responseType: `${MessageType.TrackCreate}.ack`, timeoutMs: 30000 },
    );
    const trackId = (response.payload as { trackId: string }).trackId;
    if (!trackId) {
      throw new Error(`Track creation failed for ${type}`);
    }
    return trackId;
  }

  updateSessionUri(session: ProjectSession, newUri: vscode.Uri): void {
    this.uriToProjectId.delete(session.uri.toString());
    session.uri = newUri;
    this.uriToProjectId.set(newUri.toString(), session.projectId);
  }
}

function safeAudioFileName(input: string): string {
  const base = path.basename(input).replace(/[^\w\-. ]+/g, "_");
  return base || `audio-${Date.now()}.wav`;
}

export async function createNewProjectUri(
  context: vscode.ExtensionContext,
): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    const defaultDir = context.globalStorageUri?.fsPath ?? os.homedir();
    const result = await vscode.window.showSaveDialog({
      title: "Create VSDAW Project",
      defaultUri: vscode.Uri.file(path.join(defaultDir, "Untitled.vsdaw")),
      filters: { "VSDAW Project": ["vsdaw"] },
    });
    return result;
  }

  let index = 1;
  let candidate = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, "Untitled.vsdaw"));
  while (await fileExists(candidate)) {
    candidate = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, `Untitled-${index}.vsdaw`));
    index++;
  }
  return candidate;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function writeEmptyProject(uri: vscode.Uri): Promise<void> {
  const config = vscode.workspace.getConfiguration("vsdaw");
  const sampleRate = config.get<number>("audio.defaultSampleRate", 48000);
  const project = createEmptyProject(path.basename(uri.fsPath, ".vsdaw"), sampleRate);
  const bytes = await writeBundle(project);
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export async function openProjectFile(uri: vscode.Uri): Promise<void> {

exec
/bin/zsh -lc "nl -ba src/extension/projectManager.ts | sed -n '140,210p;520,640p;730,810p'" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
   140	      await releaseServer();
   141	      throw new vscode.CancellationError();
   142	    }
   143	    this.serverOrigin = `http://127.0.0.1:${port}`;
   144	
   145	    const projectId = crypto.randomUUID();
   146	    const isUntitled = uri.scheme !== "file";
   147	    const cleanupDisposables: vscode.Disposable[] = [];
   148	
   149	    try {
   150	      const origin = this.serverOrigin ?? `http://127.0.0.1:${port}`;
   151	      const engineTransport = await this.options.engineManager.createEngine(projectId, origin);
   152	      const engineDisposable = this.router.registerEngine(projectId, engineTransport);
   153	      cleanupDisposables.push(engineTransport, engineDisposable);
   154	
   155	      const session: ProjectSession = {
   156	        projectId,
   157	        uri,
   158	        engineReady: false,
   159	        pendingEngineMessages: [],
   160	        views: new Map(),
   161	        isDirty: false,
   162	        isUntitled,
   163	        engineDisposables: [engineTransport, engineDisposable],
   164	        audioFiles: new Map(),
   165	      };
   166	
   167	      session.views.set("vsdaw.editor", timelinePanel);
   168	      this.router.registerView(projectId, timelinePanel);
   169	
   170	      this.sessions.set(projectId, session);
   171	      this.uriToProjectId.set(uri.toString(), projectId);
   172	      this.activeProjectId = projectId;
   173	
   174	      const projector = new ProjectStateProjector({
   175	        projectId,
   176	        router: this.router,
   177	        getProjectName: () => this.getSessionProjectName(session),
   178	        getSaved: () => !session.isDirty,
   179	      });
   180	      this.projectors.set(projectId, projector);
   181	
   182	      cleanupDisposables.push(
   183	        engineTransport.onDidDispose(() => {
   184	          if (!this.sessions.has(projectId)) return;
   185	          this.outputChannel.appendLine(
   186	            `[project] engine transport closed for ${projectId}, closing session`,
   187	          );
   188	          this.closeProject(projectId).catch(() => {
   189	            // ignore
   190	          });
   191	        }),
   192	      );
   193	
   194	      cleanupDisposables.push(
   195	        timelinePanel.onDidDispose(() => {
   196	          this.closeProject(projectId).catch(() => {
   197	            // ignore
   198	          });
   199	        }),
   200	      );
   201	
   202	      if (uri.scheme === "file") {
   203	        try {
   204	          await this.loadProjectIntoSession(session, token);
   205	        } catch (error) {
   206	          if (error instanceof vscode.CancellationError) throw error;
   207	          const message = error instanceof Error ? error.message : String(error);
   208	          this.outputChannel.appendLine(`[project] failed to load ${uri.fsPath}: ${message}`);
   209	          vscode.window.showWarningMessage(
   210	            `VSDAW could not load existing project data: ${message}`,
   520	  }
   521	
   522	  private async loadProjectIntoSession(
   523	    session: ProjectSession,
   524	    token?: vscode.CancellationToken,
   525	  ): Promise<void> {
   526	    if (token?.isCancellationRequested) return;
   527	    const data = await vscode.workspace.fs.readFile(session.uri);
   528	    if (token?.isCancellationRequested) return;
   529	
   530	    let bundle: Awaited<ReturnType<typeof readBundle>>;
   531	    try {
   532	      bundle = await readBundle(new Uint8Array(data));
   533	    } catch (error) {
   534	      if (error instanceof BundleError) {
   535	        throw error;
   536	      }
   537	      throw new BundleError(
   538	        `Failed to read bundle: ${error instanceof Error ? error.message : String(error)}`,
   539	      );
   540	    }
   541	
   542	    session.projectJson = bundle.project;
   543	
   544	    if (bundle.engineBin && bundle.engineBin.byteLength > 0) {
   545	      const payload: ProjectLoadPayload = {
   546	        data: Buffer.from(bundle.engineBin).toString("base64"),
   547	      };
   548	      const loadMessage: MessageEnvelope = {
   549	        projectId: session.projectId,
   550	        direction: "host-to-engine",
   551	        type: MessageType.ProjectLoad,
   552	        payload,
   553	      };
   554	      this.queueEngineMessage(session, loadMessage);
   555	    } else {
   556	      // Empty/new project bundle: ask the engine to create a matching empty project.
   557	      const payload: ProjectNewPayload = {
   558	        bpm: bundle.project.project.tempo,
   559	        timeSignature: bundle.project.project.timeSignature,
   560	      };
   561	      const newMessage: MessageEnvelope = {
   562	        projectId: session.projectId,
   563	        direction: "host-to-engine",
   564	        type: MessageType.ProjectNew,
   565	        payload,
   566	      };
   567	      this.queueEngineMessage(session, newMessage);
   568	    }
   569	  }
   570	
   571	  private queueEngineMessage(session: ProjectSession, message: MessageEnvelope): void {
   572	    if (session.engineReady) {
   573	      this.router.routeToEngine(session.projectId, message);
   574	    } else {
   575	      session.pendingEngineMessages.push(message);
   576	    }
   577	  }
   578	
   579	  private async writeRecoveryBackup(session: ProjectSession): Promise<void> {
   580	    if (session.isSaving) {
   581	      // Avoid racing with an active save operation.
   582	      return;
   583	    }
   584	
   585	    const recoveryDir = this.getRecoveryDir();
   586	    await fs.mkdir(recoveryDir, { recursive: true });
   587	    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
   588	    const recoveryPath = path.join(recoveryDir, `${session.projectId}-${timestamp}.vsdaw`);
   589	
   590	    try {
   591	      const response = await this.router.requestEngine(
   592	        session.projectId,
   593	        MessageType.ProjectSave,
   594	        { format: "arraybuffer" },
   595	        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
   596	      );
   597	      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
   598	      if (!bytes) return;
   599	      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
   600	      const projectJson = this.buildProjectJsonForSave(session, session.uri);
   601	      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
   602	      await fs.writeFile(recoveryPath, bundle);
   603	
   604	      const metadata: RecoveryMetadata = {
   605	        originalUri: session.uri.toString(),
   606	        recoveredAt: new Date().toISOString(),
   607	        projectName: projectJson.project.name,
   608	      };
   609	      await fs.writeFile(
   610	        path.join(recoveryDir, `${session.projectId}-${timestamp}.json`),
   611	        JSON.stringify(metadata, null, 2),
   612	      );
   613	    } catch (error) {
   614	      const message = error instanceof Error ? error.message : String(error);
   615	      this.outputChannel.appendLine(`[recovery] backup skipped: ${message}`);
   616	    }
   617	  }
   618	
   619	  private async offerRecovery(): Promise<void> {
   620	    const recoveryDir = this.getRecoveryDir();
   621	    let files: string[] = [];
   622	    try {
   623	      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
   624	    } catch {
   625	      return;
   626	    }
   627	    if (files.length === 0) return;
   628	
   629	    await this.cleanupStaleRecoveryFiles(recoveryDir, files);
   630	
   631	    // Re-read after cleanup.
   632	    try {
   633	      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
   634	    } catch {
   635	      return;
   636	    }
   637	    if (files.length === 0) return;
   638	
   639	    const items = await Promise.all(
   640	      files.map(async (fileName) => {
   730	  private updateSaveIndicator(session: ProjectSession): void {
   731	    const timeline = session.views.get("vsdaw.editor");
   732	    if (timeline) {
   733	      timeline.title = session.isDirty
   734	        ? `Timeline (${session.projectId.slice(0, 8)}) •`
   735	        : `Timeline (${session.projectId.slice(0, 8)})`;
   736	    }
   737	  }
   738	
   739	  private buildProjectJsonForSave(session: ProjectSession, targetUri: vscode.Uri): ProjectJson {
   740	    const base = session.projectJson ?? createEmptyProject("Untitled", 48000);
   741	    return {
   742	      ...base,
   743	      project: {
   744	        ...base.project,
   745	        name: path.basename(targetUri.fsPath, ".vsdaw"),
   746	      },
   747	    };
   748	  }
   749	
   750	  async importAudio(uri: vscode.Uri, trackId?: string): Promise<void> {
   751	    const projectId = this.getActiveProjectId();
   752	    if (!projectId) {
   753	      throw new Error("No active VSDAW project");
   754	    }
   755	    const session = this.sessions.get(projectId);
   756	    if (!session) {
   757	      throw new Error(`No session for project ${projectId}`);
   758	    }
   759	
   760	    const fileName = path.basename(uri.fsPath);
   761	    const bytes = await vscode.workspace.fs.readFile(uri);
   762	    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
   763	    session.audioFiles.set(audioFileId, bytes);
   764	
   765	    const imported = await this.router.requestEngine(
   766	      projectId,
   767	      MessageType.AudioImport,
   768	      {
   769	        data: Buffer.from(bytes).toString("base64"),
   770	        name: fileName,
   771	      },
   772	      { responseType: `${MessageType.AudioImport}.ack`, timeoutMs: 60000 },
   773	    );
   774	    const sample = (imported.payload as { sampleId: string; sample: unknown }).sample;
   775	
   776	    const targetTrackId = trackId ?? (await this.createTrack(projectId, "audio"));
   777	
   778	    await this.router.requestEngine(
   779	      projectId,
   780	      MessageType.RegionCreateAudio,
   781	      {
   782	        trackId: targetTrackId,
   783	        audioFileId,
   784	        sample,
   785	        position: 0,
   786	        name: fileName,
   787	      },
   788	      { responseType: `${MessageType.RegionCreateAudio}.ack`, timeoutMs: 30000 },
   789	    );
   790	
   791	    this.markDirty(projectId);
   792	  }
   793	
   794	  async importMidi(uri: vscode.Uri, trackId?: string): Promise<void> {
   795	    const projectId = this.getActiveProjectId();
   796	    if (!projectId) {
   797	      throw new Error("No active VSDAW project");
   798	    }
   799	    const session = this.sessions.get(projectId);
   800	    if (!session) {
   801	      throw new Error(`No session for project ${projectId}`);
   802	    }
   803	
   804	    const fileName = path.basename(uri.fsPath);
   805	    const bytes = await vscode.workspace.fs.readFile(uri);
   806	    const parsed = parseMidiFile(bytes);
   807	
   808	    const targetTrackId = trackId ?? (await this.createTrack(projectId, "midi"));
   809	
   810	    const ticksPerQuarter = parsed.ticksPerQuarter || 960;

exec
/bin/zsh -lc "nl -ba src/extension/projectManager.ts | sed -n '210,540p'" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
   210	            `VSDAW could not load existing project data: ${message}`,
   211	          );
   212	        }
   213	      }
   214	
   215	      // Cleanup disposables are now owned by the session lifecycle.
   216	      cleanupDisposables.length = 0;
   217	      return session;
   218	    } catch (error) {
   219	      for (const d of cleanupDisposables) {
   220	        try {
   221	          d.dispose();
   222	        } catch {
   223	          // ignore
   224	        }
   225	      }
   226	      this.sessions.delete(projectId);
   227	      this.uriToProjectId.delete(uri.toString());
   228	      if (this.activeProjectId === projectId) {
   229	        this.activeProjectId = undefined;
   230	      }
   231	      await releaseServer();
   232	      if (this.sessions.size === 0) {
   233	        this.serverOrigin = undefined;
   234	      }
   235	      throw error;
   236	    }
   237	  }
   238	
   239	  async closeProject(projectId: string): Promise<void> {
   240	    const session = this.sessions.get(projectId);
   241	    if (!session || session.isClosing) return;
   242	    session.isClosing = true;
   243	
   244	    this.projectors.get(projectId)?.dispose();
   245	    this.projectors.delete(projectId);
   246	
   247	    this.clearAutoSave(session);
   248	    this.router.unregisterEngine(projectId);
   249	    session.pendingEngineMessages = [];
   250	
   251	    if (session.engineDisposables) {
   252	      for (const d of session.engineDisposables) {
   253	        try {
   254	          d.dispose();
   255	        } catch {
   256	          // ignore
   257	        }
   258	      }
   259	      session.engineDisposables = undefined;
   260	    }
   261	
   262	    for (const [, panel] of session.views) {
   263	      try {
   264	        panel.dispose();
   265	      } catch {
   266	        // ignore
   267	      }
   268	    }
   269	
   270	    this.sessions.delete(projectId);
   271	    this.uriToProjectId.delete(session.uri.toString());
   272	    if (this.activeProjectId === projectId) {
   273	      this.activeProjectId = undefined;
   274	    }
   275	
   276	    if (this.sessions.size === 0) {
   277	      await releaseServer();
   278	      this.serverOrigin = undefined;
   279	    }
   280	  }
   281	
   282	  async closeAll(): Promise<void> {
   283	    const ids = Array.from(this.sessions.keys());
   284	    for (const id of ids) {
   285	      await this.closeProject(id);
   286	    }
   287	  }
   288	
   289	  async saveProject(projectId: string, token?: vscode.CancellationToken): Promise<void> {
   290	    const session = this.sessions.get(projectId);
   291	    if (!session) {
   292	      throw new Error(`No session for project ${projectId}`);
   293	    }
   294	    await this.saveSession(session, token);
   295	  }
   296	
   297	  async saveProjectByUri(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
   298	    const session = this.getSessionByUri(uri);
   299	    if (!session) {
   300	      throw new Error(`No project session for ${uri.toString()}`);
   301	    }
   302	    await this.saveSession(session, token);
   303	  }
   304	
   305	  async saveProjectAs(
   306	    projectId: string,
   307	    destination: vscode.Uri,
   308	    token?: vscode.CancellationToken,
   309	  ): Promise<void> {
   310	    if (token?.isCancellationRequested) return;
   311	
   312	    const session = this.sessions.get(projectId);
   313	    if (!session) {
   314	      throw new Error(`No session for project ${projectId}`);
   315	    }
   316	
   317	    this.updateSessionUri(session, destination);
   318	    session.isUntitled = false;
   319	
   320	    await this.saveSession(session, token);
   321	  }
   322	
   323	  private async saveSession(
   324	    session: ProjectSession,
   325	    token?: vscode.CancellationToken,
   326	  ): Promise<void> {
   327	    if (token?.isCancellationRequested) return;
   328	
   329	    if (session.isSaving) {
   330	      // A save is already in progress; do not queue overlapping saves.
   331	      return;
   332	    }
   333	
   334	    let targetUri = session.uri;
   335	    if (session.isUntitled) {
   336	      const picked = await vscode.window.showSaveDialog({
   337	        defaultUri: targetUri,
   338	        filters: { "VSDAW Project": ["vsdaw"] },
   339	        saveLabel: "Save Project",
   340	      });
   341	      if (!picked) return;
   342	      if (token?.isCancellationRequested) return;
   343	      this.updateSessionUri(session, picked);
   344	      session.isUntitled = false;
   345	      targetUri = picked;
   346	    }
   347	
   348	    session.isSaving = true;
   349	    try {
   350	      const response = await this.router.requestEngine(
   351	        session.projectId,
   352	        MessageType.ProjectSave,
   353	        { format: "arraybuffer" },
   354	        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
   355	      );
   356	      if (token?.isCancellationRequested) return;
   357	      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
   358	      if (!bytes) {
   359	        throw new Error("Engine returned empty project data");
   360	      }
   361	
   362	      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
   363	      const projectJson = this.buildProjectJsonForSave(session, targetUri);
   364	      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
   365	      await this.writeProjectBytes(targetUri, bundle);
   366	      session.projectJson = projectJson;
   367	      session.isDirty = false;
   368	      this.updateSaveIndicator(session);
   369	      this.projectors.get(session.projectId)?.broadcastProject();
   370	      this.outputChannel.appendLine(`[project] saved ${targetUri.fsPath}`);
   371	    } finally {
   372	      session.isSaving = false;
   373	    }
   374	  }
   375	
   376	  markDirty(projectId: string): void {
   377	    const session = this.sessions.get(projectId);
   378	    if (!session || session.isClosing) return;
   379	    const becameDirty = !session.isDirty;
   380	    session.isDirty = true;
   381	    if (becameDirty) {
   382	      this._onDidChangeProject.fire(projectId);
   383	      this.projectors.get(projectId)?.broadcastProject();
   384	    }
   385	    this.updateSaveIndicator(session);
   386	    this.scheduleAutoSave(session);
   387	  }
   388	
   389	  onEngineReady(projectId: string, payload: unknown): void {
   390	    const session = this.sessions.get(projectId);
   391	    if (!session) return;
   392	    session.engineReady = true;
   393	    this.outputChannel.appendLine(
   394	      `[project] engine ready for ${projectId}: ${JSON.stringify(payload)}`,
   395	    );
   396	
   397	    for (const queued of session.pendingEngineMessages) {
   398	      this.router.routeToEngine(projectId, queued);
   399	    }
   400	    session.pendingEngineMessages = [];
   401	
   402	    this.projectors.get(projectId)?.broadcastProject();
   403	    this.requestEngineStateDump(projectId);
   404	  }
   405	
   406	  onEngineError(projectId: string, payload: unknown): void {
   407	    this.outputChannel.appendLine(
   408	      `[project] engine error for ${projectId}: ${JSON.stringify(payload)}`,
   409	    );
   410	    vscode.window.showErrorMessage(`VSDAW engine error: ${JSON.stringify(payload)}`);
   411	  }
   412	
   413	  onViewMessage(projectId: string, _message: MessageEnvelope): void {
   414	    this.markDirty(projectId);
   415	  }
   416	
   417	  onEngineStateUpdate(projectId: string, message: MessageEnvelope): void {
   418	    const projector = this.projectors.get(projectId);
   419	    if (!projector) return;
   420	
   421	    if (message.type === MessageType.StateUpdate) {
   422	      projector.handleStateUpdate(message.payload as ProjectState);
   423	    } else if (message.type === MessageType.TransportPositionChanged) {
   424	      const position = (message.payload as { position?: number }).position ?? 0;
   425	      projector.handleTransportPositionChanged(position);
   426	    }
   427	  }
   428	
   429	  onViewSelection(projectId: string, regionId: string | null): void {
   430	    this.projectors.get(projectId)?.updateSelection({
   431	      regionId: regionId ?? undefined,
   432	    });
   433	  }
   434	
   435	  private async requestEngineStateDump(projectId: string): Promise<void> {
   436	    try {
   437	      const response = await this.router.requestEngine(projectId, MessageType.StateGet, undefined, {
   438	        responseType: `${MessageType.StateGet}.result`,
   439	        timeoutMs: 10000,
   440	      });
   441	      this.projectors.get(projectId)?.handleStateUpdate(response.payload as ProjectState);
   442	    } catch (error) {
   443	      const message = error instanceof Error ? error.message : String(error);
   444	      this.outputChannel.appendLine(`[project] state dump failed: ${message}`);
   445	    }
   446	  }
   447	
   448	  private getSessionProjectName(session: ProjectSession): string {
   449	    if (session.projectJson?.project.name) {
   450	      return session.projectJson.project.name;
   451	    }
   452	    return path.basename(session.uri.fsPath, ".vsdaw") || "Untitled";
   453	  }
   454	
   455	  private scheduleAutoSave(session: ProjectSession): void {
   456	    this.clearAutoSaveTimer(session);
   457	    const config = vscode.workspace.getConfiguration("vsdaw");
   458	    if (!config.get<boolean>("autoSave", true)) return;
   459	
   460	    const delay = config.get<number>("autoSaveDelay", 500);
   461	    if (!Number.isFinite(delay) || delay < 0) {
   462	      this.outputChannel.appendLine("[autosave] invalid autoSaveDelay; skipping");
   463	      return;
   464	    }
   465	
   466	    session.autoSaveTimer = setTimeout(() => {
   467	      this.saveProject(session.projectId).catch((error) => {
   468	        const message = error instanceof Error ? error.message : String(error);
   469	        this.outputChannel.appendLine(`[autosave] failed: ${message}`);
   470	      });
   471	    }, delay);
   472	
   473	    this.scheduleBackup(session);
   474	  }
   475	
   476	  private scheduleBackup(session: ProjectSession): void {
   477	    if (session.backupTimer) return;
   478	    session.backupTimer = setInterval(() => {
   479	      this.writeRecoveryBackup(session).catch((error) => {
   480	        const message = error instanceof Error ? error.message : String(error);
   481	        this.outputChannel.appendLine(`[backup] failed: ${message}`);
   482	      });
   483	    }, BACKUP_INTERVAL_MS);
   484	  }
   485	
   486	  private clearAutoSave(session: ProjectSession): void {
   487	    this.clearAutoSaveTimer(session);
   488	    if (session.backupTimer) {
   489	      clearInterval(session.backupTimer);
   490	      session.backupTimer = undefined;
   491	    }
   492	  }
   493	
   494	  private clearAutoSaveTimer(session: ProjectSession): void {
   495	    if (session.autoSaveTimer) {
   496	      clearTimeout(session.autoSaveTimer);
   497	      session.autoSaveTimer = undefined;
   498	    }
   499	  }
   500	
   501	  private async writeProjectBytes(uri: vscode.Uri, data: Uint8Array): Promise<void> {
   502	    if (uri.scheme === "file") {
   503	      const tempPath = `${uri.fsPath}.tmp-${Date.now()}`;
   504	      const tempUri = vscode.Uri.file(tempPath);
   505	      try {
   506	        await vscode.workspace.fs.writeFile(tempUri, data);
   507	        await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
   508	      } catch (error) {
   509	        // Best-effort cleanup of the temporary file.
   510	        try {
   511	          await vscode.workspace.fs.delete(tempUri);
   512	        } catch {
   513	          // ignore
   514	        }
   515	        throw error;
   516	      }
   517	    } else {
   518	      await vscode.workspace.fs.writeFile(uri, data);
   519	    }
   520	  }
   521	
   522	  private async loadProjectIntoSession(
   523	    session: ProjectSession,
   524	    token?: vscode.CancellationToken,
   525	  ): Promise<void> {
   526	    if (token?.isCancellationRequested) return;
   527	    const data = await vscode.workspace.fs.readFile(session.uri);
   528	    if (token?.isCancellationRequested) return;
   529	
   530	    let bundle: Awaited<ReturnType<typeof readBundle>>;
   531	    try {
   532	      bundle = await readBundle(new Uint8Array(data));
   533	    } catch (error) {
   534	      if (error instanceof BundleError) {
   535	        throw error;
   536	      }
   537	      throw new BundleError(
   538	        `Failed to read bundle: ${error instanceof Error ? error.message : String(error)}`,
   539	      );
   540	    }

exec
/bin/zsh -lc "sed -n '1,520p' src/engine/projectAdapter.ts && sed -n '240,300p' src/engine/messageHandlers.ts && sed -n '240,280p' src/shared/protocol.ts && grep -R \"audioFileId\\|sampleId\\|sampleCache\\|samples\" -n src/engine src/shared src | head -200" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import { WavFile } from "@opendaw/lib-dsp";
import { Option, UUID } from "@opendaw/lib-std";
import {
  type AnyRegionBoxAdapter,
  AudioRegionBoxAdapter,
  type AudioUnitBoxAdapter,
  AudioUnitFactory,
  Devices,
  type ExportConfiguration,
  type InstrumentBox,
  InstrumentFactories,
  type NoteEventBoxAdapter,
  NoteEventCollectionBoxAdapter,
  NoteRegionBoxAdapter,
  RegionAdapters,
  RegionEditing,
  TrackType as SdkTrackType,
  type TrackBoxAdapter,
} from "@opendaw/studio-adapters";
import {
  AudioFileBox,
  AudioRegionBox,
  type AudioUnitBox,
  NoteEventBox,
  NoteRegionBox,
  TrackBox,
} from "@opendaw/studio-boxes";
import {
  AudioOfflineRenderer,
  type AudioWorklets,
  CaptureAudio,
  CaptureMidi,
  EffectFactories,
  type EffectFactory,
  GlobalSampleLoaderManager,
  GlobalSoundfontLoaderManager,
  MidiDevices,
  Project,
  type ProjectEnv,
  SampleService,
  SoundfontService,
  Workers,
} from "@opendaw/studio-core";
import { SampleStorage, SoundfontStorage } from "@opendaw/studio-core";
import type {
  TrackType as ApiTrackType,
  ExportFormat,
  ExportRenderResult,
  InsertState,
  NoteState,
  PeaksResultPayload,
  ProjectState,
  RegionState,
  TrackState,
} from "../shared/protocol.js";

export interface BootEnv extends ProjectEnv {
  audioContext: AudioContext;
  audioWorklets: AudioWorklets;
}

export interface ProjectControllerOptions {
  bootEnv: BootEnv;
  projectId: string;
  onStateChange?: (state: ProjectState) => void;
  onTransportPosition?: (position: number) => void;
}

function log(action: string, message: string) {
  console.log(`[VSDAW engine] ${action}: ${message}`);
}

function warn(action: string, message: string) {
  console.warn(`[VSDAW engine] ${action}: ${message}`);
}

export class ProjectController {
  readonly bootEnv: BootEnv;
  readonly projectId: string;
  private project: Project | null = null;
  private subscriptions: Array<() => void> = [];
  private trackNames = new Map<string, string>();
  private trackColors = new Map<string, string>();
  private trackTypes = new Map<string, ApiTrackType>();
  private takeRegions = new Map<string, AnyRegionBoxAdapter[]>();

  constructor(options: ProjectControllerOptions) {
    this.bootEnv = options.bootEnv;
    this.projectId = options.projectId;
    if (options.onStateChange) {
      this.onStateChange = options.onStateChange;
    }
    if (options.onTransportPosition) {
      this.onTransportPosition = options.onTransportPosition;
    }
  }

  private onStateChange?: (state: ProjectState) => void;
  private onTransportPosition?: (position: number) => void;

  private assertProject(): Project {
    if (this.project === null) {
      throw new Error("No project is currently open");
    }
    return this.project;
  }

  private get boxGraph() {
    return this.assertProject().boxGraph;
  }

  private get api() {
    return this.assertProject().api;
  }

  private get engine() {
    return this.assertProject().engine;
  }

  private get rootAdapter() {
    return this.assertProject().rootBoxAdapter;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  newProject(defaultBpm = 120, timeSignature: [number, number] = [4, 4]) {
    try {
      this.closeProject();
      log("project", `creating new project bpm=${defaultBpm}`);
      const env: ProjectEnv = {
        audioContext: this.bootEnv.audioContext,
        audioWorklets: this.bootEnv.audioWorklets,
        sampleManager: this.bootEnv.sampleManager,
        soundfontManager: this.bootEnv.soundfontManager,
        sampleService: this.bootEnv.sampleService,
        soundfontService: this.bootEnv.soundfontService,
      };
      this.project = Project.new(env);
      this.api.setBpm(defaultBpm);
      this.setTimeSignature(timeSignature[0], timeSignature[1]);
      this.project.startAudioWorklet();
      this.attachTransportObservers();
      this.broadcastState();
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      log("project", `newProject failed: ${text}`);
      throw error;
    }
  }

  loadProject(data: ArrayBufferLike) {
    try {
      this.closeProject();
      log("project", "loading project");
      const env: ProjectEnv = {
        audioContext: this.bootEnv.audioContext,
        audioWorklets: this.bootEnv.audioWorklets,
        sampleManager: this.bootEnv.sampleManager,
        soundfontManager: this.bootEnv.soundfontManager,
        sampleService: this.bootEnv.sampleService,
        soundfontService: this.bootEnv.soundfontService,
      };
      this.project = Project.load(env, data as ArrayBuffer);
      this.project.startAudioWorklet();
      this.attachTransportObservers();
      this.broadcastState();
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      log("project", `loadProject failed: ${text}`);
      throw error;
    }
  }

  serializeProject(): ArrayBufferLike {
    return this.assertProject().toArrayBuffer();
  }

  closeProject() {
    log("project", "closing project");
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
    if (this.project) {
      try {
        this.project.engine.stop(true);
      } catch {
        // ignore
      }
      try {
        this.project.terminate();
      } catch {
        // ignore
      }
      this.project = null;
    }
    this.trackNames.clear();
    this.trackColors.clear();
    this.trackTypes.clear();
    this.takeRegions.clear();
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  play() {
    this.engine.play();
    this.broadcastTransportState();
  }

  pause() {
    this.engine.stop(false);
    this.broadcastTransportState();
  }

  stop() {
    this.engine.stop(true);
    this.broadcastTransportState();
  }

  record() {
    this.assertProject().startRecording(false);
    this.broadcastTransportState();
  }

  seek(position: number, unit: "ppqn" | "seconds" | "bars" = "ppqn") {
    let ppqn = position;
    const bpm = this.engine.bpm.getValue();
    if (unit === "seconds") {
      ppqn = (position * bpm * 960) / 60;
    } else if (unit === "bars") {
      ppqn = position * 4 * 960;
    }
    this.engine.setPosition(Math.max(0, Math.round(ppqn)));
    this.broadcastTransportPosition();
  }

  setLoop(enabled: boolean, start?: number, end?: number) {
    const loop = this.assertProject().timelineBox.loopArea;
    this.boxGraph.beginTransaction();
    loop.enabled.setValue(enabled);
    if (start !== undefined) loop.from.setValue(start);
    if (end !== undefined) loop.to.setValue(end);
    this.boxGraph.endTransaction();
    this.broadcastTransportState();
  }

  setTempo(bpm: number) {
    this.api.setBpm(bpm);
    this.broadcastTransportState();
  }

  setTimeSignature(numerator: number, denominator: number) {
    const timeline = this.assertProject().timelineBox;
    this.boxGraph.beginTransaction();
    timeline.signature.nominator.setValue(numerator);
    timeline.signature.denominator.setValue(denominator);
    this.boxGraph.endTransaction();
    this.broadcastTransportState();
  }

  // ---------------------------------------------------------------------------
  // Tracks
  // ---------------------------------------------------------------------------

  createTrack(type: ApiTrackType, name?: string, index?: number, color?: string) {
    if (type === "master") {
      throw new Error(
        "Track type 'master' is reserved for the primary output bus and cannot be created",
      );
    }

    const project = this.assertProject();
    let audioUnit: AudioUnitBox;

    if (type === "midi") {
      const product = this.api.createInstrument(InstrumentFactories.Tape, {
        name: name ?? "MIDI Track",
      });
      audioUnit = product.audioUnitBox;
    } else if (type === "audio") {
      const capture = AudioUnitFactory.trackTypeToCapture(project.boxGraph, SdkTrackType.Audio);
      audioUnit = AudioUnitFactory.create(project.skeleton, "instrument" as any, capture, index);
      this.api.createAudioTrack(audioUnit, 0);
    } else {
      // bus
      audioUnit = AudioUnitFactory.create(project.skeleton, "bus" as any, Option.None, index);
      this.api.createAudioTrack(audioUnit, 0);
    }

    const id = UUID.toString(audioUnit.address.uuid);
    this.trackNames.set(id, name ?? `${type} track`);
    this.trackTypes.set(id, type);
    if (color) this.trackColors.set(id, color);

    // Ensure the displayed label stays in sync with our name map.
    try {
      const adapter = this.resolveAudioUnit(id);
      adapter.input.label = this.trackNames.get(id) ?? id;
    } catch {
      // ignore
    }

    if (index !== undefined) {
      const adapter = this.resolveAudioUnit(id);
      adapter.move(index - adapter.indexField.getValue());
    }

    this.broadcastState();
    return id;
  }

  deleteTrack(trackId: string) {
    const unit = this.resolveAudioUnit(trackId);
    this.api.deleteAudioUnit(unit.box);
    this.trackNames.delete(trackId);
    this.trackColors.delete(trackId);
    this.trackTypes.delete(trackId);
    this.broadcastState();
  }

  reorderTrack(trackId: string, newIndex: number) {
    const unit = this.resolveAudioUnit(trackId);
    const delta = newIndex - unit.indexField.getValue();
    if (delta !== 0) {
      unit.move(delta);
    }
    this.broadcastState();
  }

  setTrackName(trackId: string, name: string) {
    this.trackNames.set(trackId, name);
    const unit = this.resolveAudioUnit(trackId);
    try {
      unit.input.label = name;
    } catch {
      // some inputs do not support label writes
    }
    this.broadcastState();
  }

  setTrackColor(trackId: string, color: string) {
    this.trackColors.set(trackId, color);
    this.broadcastState();
  }

  setTrackVolumeDb(trackId: string, volumeDb: number) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.volume.setValue(volumeDb);
    this.broadcastState();
  }

  setTrackPan(trackId: string, pan: number) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.panning.setValue(pan);
    this.broadcastState();
  }

  setTrackMute(trackId: string, mute: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.mute.setValue(mute);
    this.broadcastState();
  }

  setTrackSolo(trackId: string, solo: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.solo.setValue(solo);
    this.broadcastState();
  }

  setTrackArm(trackId: string, arm: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    const devices = this.assertProject().captureDevices;
    const capture = devices.get(unit.box.address.uuid);
    if (capture.nonEmpty()) {
      capture.unwrap().armed.setValue(arm);
    }
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Audio regions
  // ---------------------------------------------------------------------------

  async importAudioFile(
    arrayBuffer: ArrayBuffer,
    name?: string,
    bpm?: number,
  ): Promise<{ sampleId: string; sample: any }> {
    const sample = await this.bootEnv.sampleService.importFile({
      arrayBuffer,
      name,
      bpm,
    });
    return { sampleId: sample.uuid, sample };
  }

  createAudioRegion(
    trackId: string,
    sample: {
      uuid: string;
      name: string;
      duration: number;
      bpm: number;
      sample_rate?: number;
      origin?: "recording" | "openDAW" | "import";
    },
    position: number,
    duration?: number,
    offset?: number,
    name?: string,
  ): string {
    const track = this.resolveMainTrack(trackId);
    const project = this.assertProject();

    if (!sample.uuid || !sample.name || sample.duration == null || sample.bpm == null) {
      throw new Error("Invalid sample metadata: uuid, name, duration and bpm are required");
    }

    const sampleRate = sample.sample_rate ?? this.bootEnv.audioContext.sampleRate;
    const fullSample = {
      ...sample,
      sample_rate: sampleRate,
      origin: sample.origin ?? "import",
    };

    const audioFileBox = AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid));
    const regionBox = this.api.createNotStretchedRegion({
      boxGraph: project.boxGraph,
      targetTrack: track.box,
      audioFileBox,
      sample: fullSample as any,
      position,
      duration,
      name: name ?? sample.name,
    });
    const adapter = project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter);

    if (offset !== undefined && offset !== 0) {
      try {
        adapter.waveformOffset.setValue(offset);
      } catch (error: unknown) {
        warn(
          "region",
          `could not apply offset: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.broadcastState();
    return UUID.toString(adapter.uuid);
  }

  createMidiRegion(trackId: string, position: number, duration: number, name?: string): string {
    const track = this.resolveMainTrack(trackId);
    const regionBox = this.api.createNoteRegion({
      trackBox: track.box,
      position,
      duration,
      name: name ?? "MIDI",
    });
    const adapter = this.assertProject().boxAdapters.adapterFor(regionBox, NoteRegionBoxAdapter);
    this.broadcastState();
    return UUID.toString(adapter.uuid);
  }

  moveRegion(regionId: string, position: number, trackId?: string) {
    const region = this.resolveRegion(regionId);
    this.boxGraph.beginTransaction();
    region.position = position;
    if (trackId) {
      const track = this.resolveMainTrack(trackId);
      region.box.regions.refer(track.box.regions);
    }
    this.boxGraph.endTransaction();
    this.broadcastState();
  }

  resizeRegion(regionId: string, duration: number) {
    const region = this.resolveRegion(regionId);
    region.duration = duration;
    this.broadcastState();
  }

  splitRegion(regionId: string, position: number): string[] {
    const region = this.resolveRegion(regionId);
    this.boxGraph.beginTransaction();
    const split = RegionEditing.cut(region, position, false);
    this.boxGraph.endTransaction();
    if (split.isEmpty()) {
      return [regionId];
    }
    this.broadcastState();
    return [regionId, UUID.toString(split.unwrap().uuid)];
  }

  setFadeIn(regionId: string, value: number) {
    const region = this.resolveAudioRegion(regionId);
    region.fading.inField.setValue(value);
    this.broadcastState();
  }

  setFadeOut(regionId: string, value: number) {
    const region = this.resolveAudioRegion(regionId);
    region.fading.outField.setValue(value);
    this.broadcastState();
  }

  deleteRegion(regionId: string) {
    const region = this.resolveRegion(regionId);
    region.box.delete();
    this.broadcastState();
  }
        return { type: "error", message: "insertId is required" };
      }
      controller.deleteDevice(opts.insertId);
      return { type: "ok" };
    }
    case MessageType.TrackMoveInsert: {
      const opts = p as TrackInsertMovePayload;
      if (!opts?.insertId || opts.newIndex == null) {
        return { type: "error", message: "insertId and newIndex are required" };
      }
      controller.moveDevice(opts.insertId, opts.newIndex);
      return { type: "ok" };
    }
    case MessageType.TrackSetInsertParameter: {
      const opts = p as DeviceParameterPayload;
      if (!opts?.deviceId || opts.parameter == null || opts.value == null) {
        return { type: "error", message: "deviceId, parameter and value are required" };
      }
      controller.setDeviceParameter(opts.deviceId, opts.parameter, opts.value);
      return { type: "ok" };
    }

    // Regions
    case MessageType.RegionCreateAudio: {
      const opts = p as RegionCreateAudioPayload;
      if (!opts?.trackId || opts.position == null) {
        return { type: "error", message: "trackId and position are required" };
      }
      // The host must have imported the audio file first and pass the sample record.
      // For the protocol we accept a serialized sample object in the payload.
      const sample = (p as any).sample ?? {
        uuid: opts.audioFileId,
        name: opts.name ?? "audio",
        duration: opts.duration ?? 0,
        bpm: 120,
      };
      if (!sample.uuid || sample.duration == null || sample.bpm == null) {
        return { type: "error", message: "Audio sample metadata is incomplete" };
      }
      const id = controller.createAudioRegion(
        opts.trackId,
        sample,
        opts.position,
        opts.duration,
        opts.offset,
        opts.name,
      );
      return { type: "ok", payload: { regionId: id } };
    }
    case MessageType.RegionCreateMidi: {
      const opts = p as RegionCreateMidiPayload;
      if (!opts?.trackId || opts.position == null || opts.duration == null) {
        return { type: "error", message: "trackId, position and duration are required" };
      }
      const id = controller.createMidiRegion(opts.trackId, opts.position, opts.duration, opts.name);
      return { type: "ok", payload: { regionId: id } };
    }
    case MessageType.RegionMove: {
      const opts = p as RegionMovePayload;
      if (!opts?.regionId || opts.position == null) {
        return { type: "error", message: "regionId and position are required" };
  trackId: string;
  deviceName: string;
  insertIndex?: number;
}

export interface TrackInsertRemovePayload {
  insertId: string;
}

export interface TrackInsertMovePayload {
  insertId: string;
  newIndex: number;
}

export interface RegionCreateAudioPayload {
  trackId: string;
  audioFileId: string;
  position: number;
  duration?: number;
  offset?: number;
  name?: string;
  sample?: unknown;
}

export interface RegionCreateMidiPayload {
  trackId: string;
  position: number;
  duration: number;
  name?: string;
}

export interface RegionMovePayload {
  regionId: string;
  position: number;
  trackId?: string;
}

export interface RegionResizePayload {
  regionId: string;
  duration: number;
}
src/engine/projectAdapter.ts:396:  ): Promise<{ sampleId: string; sample: any }> {
src/engine/projectAdapter.ts:402:    return { sampleId: sample.uuid, sample };
src/engine/projectAdapter.ts:765:  async getPeaks(sampleId: string, width: number, channel = 0): Promise<PeaksResultPayload> {
src/engine/projectAdapter.ts:766:    const loader = this.bootEnv.sampleManager.getOrCreate(UUID.parse(sampleId));
src/engine/projectAdapter.ts:784:      sampleId,
src/engine/messageHandlers.ts:271:        uuid: opts.audioFileId,
src/engine/messageHandlers.ts:497:      if (!opts?.sampleId || opts.width == null) {
src/engine/messageHandlers.ts:498:        return { type: "error", message: "sampleId and width are required" };
src/engine/messageHandlers.ts:501:        .getPeaks(opts.sampleId, opts.width, opts.channel)
src/engine/workers/peakWorker.ts:18: *   sampleId?: string;
src/engine/workers/peakWorker.ts:29:  sampleId?: string;
src/engine/workers/peakWorker.ts:40:  sampleId?: string;
src/engine/workers/peakWorker.ts:76:    sampleId,
src/engine/workers/peakWorker.ts:89:      sampleId,
src/shared/protocol.ts:256:  audioFileId: string;
src/shared/protocol.ts:363:  sampleId: string;
src/shared/protocol.ts:450:  sampleId: string;
src/shared/peaks.ts:8:  samplesPerPeak: number;
src/shared/peaks.ts:12:function validateSamplesPerPeak(samplesPerPeak: number): void {
src/shared/peaks.ts:13:  if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
src/shared/peaks.ts:14:    throw new RangeError("samplesPerPeak must be a positive integer");
src/shared/peaks.ts:67:  const { samplesPerPeak } = options;
src/shared/peaks.ts:68:  validateSamplesPerPeak(samplesPerPeak);
src/shared/peaks.ts:71:  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
src/shared/peaks.ts:76:  samplesPerPeak: number,
src/shared/peaks.ts:81:  validateSamplesPerPeak(samplesPerPeak);
src/shared/peaks.ts:82:  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
src/shared/peaks.ts:87:  samplesPerPeak: number,
src/shared/peaks.ts:94:  const peakCount = Math.ceil(totalFrames / samplesPerPeak);
src/shared/peaks.ts:98:    const start = i * samplesPerPeak;
src/shared/peaks.ts:99:    const end = Math.min(start + samplesPerPeak, totalFrames);
src/shared/time.ts:22:export function samplesToSeconds(samples: number, sampleRate: number): number {
src/shared/time.ts:24:  return samples / sampleRate;
src/shared/time.ts:32:export function samplesToBeats(samples: number, sampleRate: number, tempo: number): number {
src/shared/time.ts:35:  const seconds = samplesToSeconds(samples, sampleRate);
src/shared/time.ts:52:export function samplesToBarsBeatsTicks(
src/shared/time.ts:53:  samples: number,
src/shared/time.ts:64:  const totalBeats = samplesToBeats(samples, sampleRate, tempo);
src/extension/projectManager.ts:762:    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
src/extension/projectManager.ts:763:    session.audioFiles.set(audioFileId, bytes);
src/extension/projectManager.ts:774:    const sample = (imported.payload as { sampleId: string; sample: unknown }).sample;
src/extension/projectManager.ts:783:        audioFileId,
src/shared/protocol.ts:256:  audioFileId: string;
src/shared/protocol.ts:363:  sampleId: string;
src/shared/protocol.ts:450:  sampleId: string;
src/shared/peaks.ts:8:  samplesPerPeak: number;
src/shared/peaks.ts:12:function validateSamplesPerPeak(samplesPerPeak: number): void {
src/shared/peaks.ts:13:  if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
src/shared/peaks.ts:14:    throw new RangeError("samplesPerPeak must be a positive integer");
src/shared/peaks.ts:67:  const { samplesPerPeak } = options;
src/shared/peaks.ts:68:  validateSamplesPerPeak(samplesPerPeak);
src/shared/peaks.ts:71:  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
src/shared/peaks.ts:76:  samplesPerPeak: number,
src/shared/peaks.ts:81:  validateSamplesPerPeak(samplesPerPeak);
src/shared/peaks.ts:82:  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
src/shared/peaks.ts:87:  samplesPerPeak: number,
src/shared/peaks.ts:94:  const peakCount = Math.ceil(totalFrames / samplesPerPeak);
src/shared/peaks.ts:98:    const start = i * samplesPerPeak;
src/shared/peaks.ts:99:    const end = Math.min(start + samplesPerPeak, totalFrames);
src/shared/time.ts:22:export function samplesToSeconds(samples: number, sampleRate: number): number {
src/shared/time.ts:24:  return samples / sampleRate;
src/shared/time.ts:32:export function samplesToBeats(samples: number, sampleRate: number, tempo: number): number {
src/shared/time.ts:35:  const seconds = samplesToSeconds(samples, sampleRate);
src/shared/time.ts:52:export function samplesToBarsBeatsTicks(
src/shared/time.ts:53:  samples: number,
src/shared/time.ts:64:  const totalBeats = samplesToBeats(samples, sampleRate, tempo);
src/engine/projectAdapter.ts:396:  ): Promise<{ sampleId: string; sample: any }> {
src/engine/projectAdapter.ts:402:    return { sampleId: sample.uuid, sample };
src/engine/projectAdapter.ts:765:  async getPeaks(sampleId: string, width: number, channel = 0): Promise<PeaksResultPayload> {
src/engine/projectAdapter.ts:766:    const loader = this.bootEnv.sampleManager.getOrCreate(UUID.parse(sampleId));
src/engine/projectAdapter.ts:784:      sampleId,
src/engine/messageHandlers.ts:271:        uuid: opts.audioFileId,
src/engine/messageHandlers.ts:497:      if (!opts?.sampleId || opts.width == null) {
src/engine/messageHandlers.ts:498:        return { type: "error", message: "sampleId and width are required" };
src/engine/messageHandlers.ts:501:        .getPeaks(opts.sampleId, opts.width, opts.channel)
src/engine/workers/peakWorker.ts:18: *   sampleId?: string;
src/engine/workers/peakWorker.ts:29:  sampleId?: string;
src/engine/workers/peakWorker.ts:40:  sampleId?: string;
src/engine/workers/peakWorker.ts:76:    sampleId,
src/engine/workers/peakWorker.ts:89:      sampleId,

exec
/bin/zsh -lc "grep -R \"sampleService\\|SampleService\\|SampleStorage\\|importFile\" -n src tests package.json | head -200" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
src/engine/projectAdapter.ts:40:  SampleService,
src/engine/projectAdapter.ts:44:import { SampleStorage, SoundfontStorage } from "@opendaw/studio-core";
src/engine/projectAdapter.ts:137:        sampleService: this.bootEnv.sampleService,
src/engine/projectAdapter.ts:162:        sampleService: this.bootEnv.sampleService,
src/engine/projectAdapter.ts:397:    const sample = await this.bootEnv.sampleService.importFile({
src/engine/projectAdapter.ts:1168:  const sampleService = new SampleService(audioContext);
src/engine/projectAdapter.ts:1170:  const sampleManager = new GlobalSampleLoaderManager(SampleStorage.get() as any);
src/engine/projectAdapter.ts:1175:    sampleService,
src/engine/engine.ts:6:  SampleService,
src/engine/engine.ts:7:  SampleStorage,

exec
/bin/zsh -lc "sed -n '1120,1205p' src/engine/projectAdapter.ts && sed -n '1,180p' src/engine/engine.ts && grep -R \"readBundle\" -n src tests | head -100" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
  private broadcastTransportState() {
    this.broadcastState();
  }

  private broadcastTransportPosition() {
    this.onTransportPosition?.(this.engine.position.getValue());
  }
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function generatePeaks(
  frames: ReadonlyArray<Float32Array>,
  width: number,
  channel: number,
): Float32Array {
  const ch = Math.min(channel, frames.length - 1);
  const data = frames[ch];
  const framesPerPixel = Math.max(1, Math.floor(data.length / width));
  const out = new Float32Array(width * 2);
  for (let i = 0; i < width; i++) {
    const start = i * framesPerPixel;
    const end = Math.min(start + framesPerPixel, data.length);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[i * 2] = min;
    out[i * 2 + 1] = max;
  }
  return out;
}

export function createBootEnv(audioContext: AudioContext, audioWorklets: AudioWorklets): BootEnv {
  const sampleService = new SampleService(audioContext);
  const soundfontService = new SoundfontService();
  const sampleManager = new GlobalSampleLoaderManager(SampleStorage.get() as any);
  const soundfontManager = new GlobalSoundfontLoaderManager(SoundfontStorage.get() as any);
  return {
    audioContext,
    audioWorklets,
    sampleService,
    soundfontService,
    sampleManager,
    soundfontManager,
  };
}
import {
  AudioWorklets,
  GlobalSampleLoaderManager,
  GlobalSoundfontLoaderManager,
  OfflineEngineRenderer,
  SampleService,
  SampleStorage,
  SoundfontService,
  SoundfontStorage,
  Workers,
} from "@opendaw/studio-core";
import {
  type EngineErrorPayload,
  type EngineReadyPayload,
  type Message,
  MessageType,
  type ProjectState,
  isEngineMessage,
} from "../shared/protocol.js";
import { handleMessage } from "./messageHandlers.js";
import { ProjectController, createBootEnv } from "./projectAdapter.js";

const projectId = new URLSearchParams(window.location.search).get("projectId") ?? "default";

function log(source: string, message: string) {
  console.log(`[VSDAW engine] ${source}: ${message}`);
}

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
  log("status", text);
}

declare global {
  interface Window {
    vsdawSend?: (message: Message<unknown>) => void;
    vsdawReceiveMessage?: (message: Message<unknown>) => void;
  }
}

function isPlaywrightBridge(): boolean {
  return typeof window.vsdawSend === "function";
}

function sendToHost<T>(message: Message<T>) {
  if (isPlaywrightBridge()) {
    window.vsdawSend?.(message as Message<unknown>);
  } else {
    window.parent.postMessage(message, "*");
  }
}

function post<T>(type: string, payload: T, requestId?: string) {
  const message: Message<T> = {
    direction: "engine-to-host",
    projectId,
    type,
    payload,
    requestId,
  };
  sendToHost(message);
}

function notifyHost<T>(type: string, payload: T) {
  const message: Message<T> = {
    direction: "engine-to-host",
    projectId,
    type,
    payload,
  };
  sendToHost(message);
}

let controller: ProjectController | null = null;

async function boot() {
  try {
    log("boot", `projectId=${projectId}`);

    if (!window.crossOriginIsolated) {
      throw new Error(
        `crossOriginIsolated is false (${window.crossOriginIsolated}). Ensure COOP/COEP headers are set.`,
      );
    }

    const origin = window.location.origin;
    const workersUrl = new URL("/workers-main.js", origin).href;
    const processorsUrl = new URL("/processors.js", origin).href;
    const offlineEngineUrl = new URL("/offline-engine.js", origin).href;

    setStatus("Installing workers...");
    await Workers.install(workersUrl);

    setStatus("Installing audio worklets...");
    AudioWorklets.install(processorsUrl);
    OfflineEngineRenderer.install(offlineEngineUrl);

    setStatus("Creating AudioContext...");
    let audioContext: AudioContext;
    try {
      audioContext = new AudioContext({ latencyHint: 0 });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create AudioContext: ${reason}`);
    }

    setStatus("Creating AudioWorklets...");
    const audioWorklets = await AudioWorklets.createFor(audioContext);

    setStatus("Creating project environment...");
    const bootEnv = createBootEnv(audioContext, audioWorklets);

    setStatus("Creating controller...");
    controller = new ProjectController({
      bootEnv,
      projectId,
      onStateChange: (state: ProjectState) => {
        notifyHost(MessageType.StateUpdate, state);
      },
      onTransportPosition: (position: number) => {
        notifyHost(MessageType.TransportPositionChanged, { position });
      },
    });

    // Create a default empty project so the engine is immediately usable.
    controller.newProject();

    setStatus("Resuming AudioContext on first user gesture...");
    resumeOnUserGesture(audioContext);

    setStatus("Ready.");
    const readyPayload: EngineReadyPayload = {
      crossOriginIsolated: window.crossOriginIsolated,
      audioContextState: audioContext.state,
      sampleRate: audioContext.sampleRate,
    };
    post(MessageType.EngineReady, readyPayload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log("boot", `failed: ${message}`);
    setStatus(`Error: ${message}`);
    const errorPayload: EngineErrorPayload = { message, stack };
    post(MessageType.EngineError, errorPayload);
  }
}

function resumeOnUserGesture(audioContext: AudioContext) {
  const resume = async () => {
    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
        log("audio", `AudioContext resumed, state=${audioContext.state}`);
      } catch (error: unknown) {
        console.warn("Could not resume AudioContext:", error);
      }
    }
  };
  window.addEventListener("click", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
}

async function onHostMessage(event: MessageEvent<unknown> | Message<unknown>) {
  const message = (event instanceof MessageEvent ? event.data : event) as Message<unknown>;
  if (!isEngineMessage(message)) return;
  if (message.direction !== "host-to-engine") return;
  if (message.projectId !== projectId) return;

  log(
    "message",
    `received ${message.type}${message.requestId ? ` requestId=${message.requestId}` : ""}`,
  );

  if (message.type === MessageType.Ping) {
    post(MessageType.Pong, { time: Date.now() }, message.requestId);
    return;
  }

  if (!controller) {
src/extension/projectManager.ts:6:import { BundleError, createEmptyProject, readBundle, writeBundle } from "../shared/bundle.js";
src/extension/projectManager.ts:530:    let bundle: Awaited<ReturnType<typeof readBundle>>;
src/extension/projectManager.ts:532:      bundle = await readBundle(new Uint8Array(data));
src/shared/bundle.ts:58:export async function readBundle(data: Uint8Array): Promise<BundleReadResult> {
tests/unit/projectRoundTrip.test.ts:4:  readBundle,
tests/unit/projectRoundTrip.test.ts:13:    const { project: readProject } = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:53:    const { project: readProject } = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:78:    const { project: readProject } = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:96:    const { project: readProject, audioFiles: readAudio } = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:139:    const { project: readProject }: BundleReadResult = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:155:    const { project: readProject, audioFiles } = await readBundle(bytes);
tests/unit/projectRoundTrip.test.ts:167:    const { project: readProject, engineBin: readEngineBin } = await readBundle(bytes);
tests/unit/bundle.test.ts:4:  readBundle,
tests/unit/bundle.test.ts:19:  test("writeBundle and readBundle round-trip without audio", async () => {
tests/unit/bundle.test.ts:24:    const { project: readProject, audioFiles } = await readBundle(bytes);
tests/unit/bundle.test.ts:35:    const { audioFiles: readAudio } = await readBundle(bytes);
tests/unit/bundle.test.ts:41:  test("readBundle rejects non-ZIP data", async () => {
tests/unit/bundle.test.ts:42:    await expect(readBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow(BundleError);
tests/unit/bundle.test.ts:45:  test("readBundle rejects ZIP without project.json", async () => {
tests/unit/bundle.test.ts:50:    await expect(readBundle(bytes)).rejects.toThrow(BundleError);
tests/unit/bundle.test.ts:53:  test("readBundle rejects invalid project.json content", async () => {
tests/unit/bundle.test.ts:58:    await expect(readBundle(bytes)).rejects.toThrow(BundleError);

exec
/bin/zsh -lc "sed -n '1,220p' tests/unit/projectRoundTrip.test.ts && sed -n '1,120p' tests/unit/bundle.test.ts && grep -R \"ProjectSession\" -n src tests | head -100" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import {
  type BundleReadResult,
  createEmptyProject,
  readBundle,
  writeBundle,
} from "../../src/shared/bundle.js";
import { projectJsonSchema } from "../../src/shared/schemas.js";

describe("project save/load round-trip", () => {
  test("empty project round-trips through bundle", async () => {
    const project = createEmptyProject("Round-trip", 48000);
    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.$schema).toBe("vsdaw://project.json/v1");
    expect(readProject.version).toBe(project.version);
    expect(readProject.createdBy).toBe("vsdaw");
    expect(readProject.project.name).toBe("Round-trip");
    expect(readProject.project.sampleRate).toBe(48000);
    expect(readProject.tracks).toHaveLength(1);
  });

  test("project with multiple tracks round-trips", async () => {
    const project = createEmptyProject("Multi-track", 44100);
    project.tracks.push(
      {
        id: "track-2",
        name: "MIDI 1",
        type: "midi",
        color: "#10b981",
        volumeDb: -6,
        pan: -0.25,
        mute: false,
        solo: true,
        arm: false,
        inserts: [],
      },
      {
        id: "track-3",
        name: "Bus A",
        type: "bus",
        color: "#f59e0b",
        volumeDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        arm: false,
        inserts: [],
      },
    );

    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.tracks).toHaveLength(3);
    expect(readProject.tracks[1].name).toBe("MIDI 1");
    expect(readProject.tracks[1].type).toBe("midi");
    expect(readProject.tracks[1].solo).toBe(true);
    expect(readProject.tracks[2].type).toBe("bus");
  });

  test("project with regions round-trips", async () => {
    const project = createEmptyProject("With regions", 48000);
    project.project.tempo = 128;
    project.project.timeSignature = [3, 4];
    project.regions.push({
      id: "region-1",
      trackId: "track-1",
      audioFile: "audio/vocal.wav",
      start: 0,
      duration: 48000,
      offset: 0,
      fadeIn: { type: "linear", duration: 100 },
      fadeOut: { type: "linear", duration: 200 },
    });

    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.regions).toHaveLength(1);
    expect(readProject.regions[0].trackId).toBe("track-1");
    expect(readProject.regions[0].audioFile).toBe("audio/vocal.wav");
    expect(readProject.regions[0].duration).toBe(48000);
    expect(readProject.project.tempo).toBe(128);
    expect(readProject.project.timeSignature).toEqual([3, 4]);
  });

  test("project with embedded audio files round-trips", async () => {
    const project = createEmptyProject("With embedded audio", 48000);
    const audioFiles = new Map<string, Uint8Array>([
      ["audio/kick.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00])],
      ["audio/snare.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0x00])],
    ]);

    const bytes = await writeBundle(project, audioFiles);
    const { project: readProject, audioFiles: readAudio } = await readBundle(bytes);

    expect(readProject.project.name).toBe("With embedded audio");
    expect(readAudio.size).toBe(2);
    expect(readAudio.get("audio/kick.wav")).toEqual(audioFiles.get("audio/kick.wav"));
    expect(readAudio.get("audio/snare.wav")).toEqual(audioFiles.get("audio/snare.wav"));
  });

  test("invalid audio paths are rejected during write", async () => {
    const project = createEmptyProject("Bad path", 48000);
    const audioFiles = new Map<string, Uint8Array>([
      ["audio/../escape.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46])],
    ]);

    await expect(writeBundle(project, audioFiles)).rejects.toThrow("Invalid audio file path");
  });

  test("round-tripped project still validates against schema", async () => {
    const project = createEmptyProject("Validated", 48000);
    project.tracks.push({
      id: "track-2",
      name: "Synth",
      type: "midi",
      color: "#8b5cf6",
      volumeDb: -12,
      pan: 0.5,
      mute: true,
      solo: false,
      arm: true,
      inserts: [],
    });
    project.regions.push({
      id: "region-1",
      trackId: "track-1",
      audioFile: "audio/loop.wav",
      start: 0,
      duration: 96000,
      offset: 0,
      fadeIn: { type: "linear", duration: 0 },
      fadeOut: { type: "linear", duration: 0 },
    });

    const bytes = await writeBundle(project);
    const { project: readProject }: BundleReadResult = await readBundle(bytes);

    const result = projectJsonSchema.safeParse(readProject);
    expect(result.success).toBe(true);
  });

  test("re-read project ignores non-audio zip entries", async () => {
    const { default: JSZip } = await import("jszip");
    const project = createEmptyProject("Extras", 48000);
    const zip = new JSZip();
    zip.file("project.json", JSON.stringify(project, null, 2));
    zip.file("notes.txt", "backup notes");
    zip.folder("audio");
    zip.file("audio/loop.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const { project: readProject, audioFiles } = await readBundle(bytes);

    expect(readProject.project.name).toBe("Extras");
    expect(audioFiles.size).toBe(1);
    expect(audioFiles.has("audio/loop.wav")).toBe(true);
  });

  test("project with engine.bin round-trips", async () => {
    const project = createEmptyProject("Engine state", 48000);
    const engineBin = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    const bytes = await writeBundle(project, new Map(), engineBin);
    const { project: readProject, engineBin: readEngineBin } = await readBundle(bytes);

    expect(readProject.project.name).toBe("Engine state");
    expect(readEngineBin).toEqual(engineBin);
  });
});
import {
  BundleError,
  createEmptyProject,
  readBundle,
  writeBundle,
} from "../../src/shared/bundle.js";
import { projectJsonSchema } from "../../src/shared/schemas.js";

describe("bundle", () => {
  test("createEmptyProject produces a valid project.json", () => {
    const project = createEmptyProject("Test", 44100);
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(true);
    expect(project.project.name).toBe("Test");
    expect(project.project.sampleRate).toBe(44100);
    expect(project.tracks).toHaveLength(1);
  });

  test("writeBundle and readBundle round-trip without audio", async () => {
    const project = createEmptyProject("Round-trip", 48000);
    const bytes = await writeBundle(project);
    expect(bytes.length).toBeGreaterThan(0);

    const { project: readProject, audioFiles } = await readBundle(bytes);
    expect(readProject.project.name).toBe("Round-trip");
    expect(audioFiles.size).toBe(0);
  });

  test("writeBundle embeds audio files", async () => {
    const project = createEmptyProject("With audio", 48000);
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
    const audioFiles = new Map<string, Uint8Array>([["audio/test.wav", audio]]);
    const bytes = await writeBundle(project, audioFiles);

    const { audioFiles: readAudio } = await readBundle(bytes);
    expect(readAudio.size).toBe(1);
    expect(readAudio.has("audio/test.wav")).toBe(true);
    expect(readAudio.get("audio/test.wav")).toEqual(audio);
  });

  test("readBundle rejects non-ZIP data", async () => {
    await expect(readBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow(BundleError);
  });

  test("readBundle rejects ZIP without project.json", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readBundle(bytes)).rejects.toThrow(BundleError);
  });

  test("readBundle rejects invalid project.json content", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("project.json", "not json");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readBundle(bytes)).rejects.toThrow(BundleError);
  });
});
src/extension/types.ts:7:export interface ProjectSession {
src/extension/projectManager.ts:19:import type { MessageEnvelope, ProjectSession } from "./types.js";
src/extension/projectManager.ts:38:  private sessions = new Map<string, ProjectSession>();
src/extension/projectManager.ts:76:  getSession(projectId: string): ProjectSession | undefined {
src/extension/projectManager.ts:80:  getSessionByUri(uri: vscode.Uri): ProjectSession | undefined {
src/extension/projectManager.ts:113:  ): Promise<ProjectSession> {
src/extension/projectManager.ts:133:  ): Promise<ProjectSession> {
src/extension/projectManager.ts:155:      const session: ProjectSession = {
src/extension/projectManager.ts:324:    session: ProjectSession,
src/extension/projectManager.ts:448:  private getSessionProjectName(session: ProjectSession): string {
src/extension/projectManager.ts:455:  private scheduleAutoSave(session: ProjectSession): void {
src/extension/projectManager.ts:476:  private scheduleBackup(session: ProjectSession): void {
src/extension/projectManager.ts:486:  private clearAutoSave(session: ProjectSession): void {
src/extension/projectManager.ts:494:  private clearAutoSaveTimer(session: ProjectSession): void {
src/extension/projectManager.ts:523:    session: ProjectSession,
src/extension/projectManager.ts:571:  private queueEngineMessage(session: ProjectSession, message: MessageEnvelope): void {
src/extension/projectManager.ts:579:  private async writeRecoveryBackup(session: ProjectSession): Promise<void> {
src/extension/projectManager.ts:730:  private updateSaveIndicator(session: ProjectSession): void {
src/extension/projectManager.ts:739:  private buildProjectJsonForSave(session: ProjectSession, targetUri: vscode.Uri): ProjectJson {
src/extension/projectManager.ts:868:  updateSessionUri(session: ProjectSession, newUri: vscode.Uri): void {

exec
/bin/zsh -lc "sed -n '1,260p' src/extension/stateProjector.ts && sed -n '1,220p' src/shared/schemas.ts && grep -R \"ProjectJson\\|audioFile\" -n src/engine src/extension src/shared | head -200" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import type {
  RegionState as EngineRegionState,
  TrackState as EngineTrackState,
  ProjectState,
  TransportState,
} from "../shared/protocol.js";
import { DEFAULT_PPQN, ppqnToBarsBeatsTicks, ppqnToSeconds } from "../shared/time.js";
import type {
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
      tracks: state.tracks.map((track) => this.convertTrack(track, state.regions)),
    };
  }

  private convertTrack(track: EngineTrackState, regions: EngineRegionState[]): ViewTrackState {
    return {
      id: track.id,
      name: track.name,
      color: track.color ?? defaultTrackColor(track.index),
      muted: track.mute,
      soloed: track.solo,
      armed: track.arm,
      volume: dbToLinear(track.volumeDb),
      pan: track.pan,
      height: DEFAULT_TRACK_HEIGHT,
      regions: regions
        .filter((region) => region.trackId === track.id)
        .map((region) => this.convertRegion(region)),
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

function selectionEquals(a: SelectionState, b: SelectionState): boolean {
  if (a.trackId !== b.trackId) return false;
  if (a.regionId !== b.regionId) return false;
  const aIds = a.noteIds ?? [];
  const bIds = b.noteIds ?? [];
  if (aIds.length !== bIds.length) return false;
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) return false;
  }
  return true;
}
import { z } from "zod";

export const timeSignatureSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);

export const loopSchema = z.object({
  enabled: z.boolean(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const projectMetadataSchema = z.object({
  name: z.string().min(1),
  sampleRate: z.number().int().positive(),
  tempo: z.number().positive(),
  timeSignature: timeSignatureSchema,
  loop: loopSchema,
});

export const trackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(["audio", "midi", "bus", "master"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  volumeDb: z.number(),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  arm: z.boolean(),
  inserts: z.array(z.unknown()),
});

const audioFilePathRegex = /^audio\/[\w\-. ]+\.\w+$/i;

export const regionSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  audioFile: z.string().regex(audioFilePathRegex).optional(),
  start: z.number().int(),
  duration: z.number().int().positive(),
  offset: z.number().int().default(0),
  fadeIn: z
    .object({ type: z.string(), duration: z.number().nonnegative() })
    .default({ type: "linear", duration: 0 }),
  fadeOut: z
    .object({ type: z.string(), duration: z.number().nonnegative() })
    .default({ type: "linear", duration: 0 }),
});

export const projectJsonSchema = z.object({
  $schema: z.literal("vsdaw://project.json/v1"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdBy: z.literal("vsdaw"),
  createdAt: z.string().datetime(),
  project: projectMetadataSchema,
  tracks: z.array(trackSchema),
  regions: z.array(regionSchema),
  midiClips: z.array(z.unknown()),
  automation: z.array(z.unknown()),
  mixer: z.object({ masterVolumeDb: z.number() }),
});

export type ProjectJson = z.infer<typeof projectJsonSchema>;
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Region = z.infer<typeof regionSchema>;
src/engine/projectAdapter.ts:434:    const audioFileBox = AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid));
src/engine/projectAdapter.ts:438:      audioFileBox,
src/engine/messageHandlers.ts:271:        uuid: opts.audioFileId,
src/extension/types.ts:3:import type { ProjectJson } from "../shared/schemas.js";
src/extension/types.ts:19:  projectJson?: ProjectJson;
src/extension/types.ts:22:  audioFiles: Map<string, Uint8Array>;
src/extension/projectManager.ts:14:import type { ProjectJson } from "../shared/schemas.js";
src/extension/projectManager.ts:164:        audioFiles: new Map(),
src/extension/projectManager.ts:363:      const projectJson = this.buildProjectJsonForSave(session, targetUri);
src/extension/projectManager.ts:364:      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
src/extension/projectManager.ts:600:      const projectJson = this.buildProjectJsonForSave(session, session.uri);
src/extension/projectManager.ts:601:      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
src/extension/projectManager.ts:739:  private buildProjectJsonForSave(session: ProjectSession, targetUri: vscode.Uri): ProjectJson {
src/extension/projectManager.ts:762:    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
src/extension/projectManager.ts:763:    session.audioFiles.set(audioFileId, bytes);
src/extension/projectManager.ts:783:        audioFileId,
src/shared/schemas.ts:35:const audioFilePathRegex = /^audio\/[\w\-. ]+\.\w+$/i;
src/shared/schemas.ts:40:  audioFile: z.string().regex(audioFilePathRegex).optional(),
src/shared/schemas.ts:65:export type ProjectJson = z.infer<typeof projectJsonSchema>;
src/shared/protocol.ts:256:  audioFileId: string;
src/shared/bundle.ts:2:import { type ProjectJson, projectJsonSchema } from "./schemas.js";
src/shared/bundle.ts:5:  project: ProjectJson;
src/shared/bundle.ts:6:  audioFiles: Map<string, Uint8Array>;
src/shared/bundle.ts:11:  project: ProjectJson;
src/shared/bundle.ts:12:  audioFiles?: Map<string, Uint8Array>;
src/shared/bundle.ts:23:export function createEmptyProject(name = "Untitled", sampleRate = 48000): ProjectJson {
src/shared/bundle.ts:89:  const audioFiles = new Map<string, Uint8Array>();
src/shared/bundle.ts:96:      audioFiles.set(safeName, buffer);
src/shared/bundle.ts:103:  return { project: parsed.data, audioFiles, engineBin };
src/shared/bundle.ts:107:  project: ProjectJson,
src/shared/bundle.ts:108:  audioFiles: Map<string, Uint8Array> = new Map(),
src/shared/bundle.ts:124:  if (audioFiles.size > 0) {
src/shared/bundle.ts:129:    for (const [relativePath, data] of audioFiles) {

exec
/bin/zsh -lc "sed -n '1,430p' src/extension/messageRouter.ts && grep -R \"MidiAddNote\\|addNote\" -n src/engine src/extension src/shared | head -100" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import * as vscode from "vscode";
import { MessageSchema, MessageType } from "../shared/protocol.js";
import type { HostMessage, ViewMessage } from "../views/shared/types.js";
import type { EngineTransport } from "./engineTransport.js";
import type { MessageEnvelope, PendingRequest } from "./types.js";
import { adaptViewMessage } from "./viewMessageAdapter.js";

export interface MessageRouterCallbacks {
  onEngineReady: (projectId: string, payload: unknown) => void;
  onEngineError: (projectId: string, payload: unknown) => void;
  onEngineStateUpdate: (projectId: string, message: MessageEnvelope) => void;
  onViewMessage: (projectId: string, message: MessageEnvelope) => void;
  onViewSelection?: (projectId: string, regionId: string | null) => void;
}

export class MessageRouter implements vscode.Disposable {
  private engines = new Map<string, EngineTransport>();
  private views = new Map<string, Set<vscode.WebviewPanel>>();
  private pending = new Map<string, Map<string, PendingRequest>>();

  constructor(
    private outputChannel: vscode.OutputChannel,
    private callbacks: MessageRouterCallbacks,
  ) {}

  dispose(): void {
    for (const [, map] of this.pending) {
      for (const [, req] of map) {
        clearTimeout(req.timeout);
        req.reject(new Error("Message router disposed"));
      }
    }
    this.pending.clear();
    this.engines.clear();
    this.views.clear();
  }

  registerEngine(projectId: string, transport: EngineTransport): vscode.Disposable {
    this.engines.set(projectId, transport);
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      transport.onDidReceiveMessage((message) => {
        this.handleEngineMessage(projectId, message);
      }),
    );

    disposables.push(
      transport.onDidDispose(() => {
        this.unregisterEngine(projectId);
        for (const d of disposables) {
          d.dispose();
        }
      }),
    );

    return {
      dispose: () => {
        for (const d of disposables) {
          d.dispose();
        }
      },
    };
  }

  unregisterEngine(projectId: string): void {
    this.engines.delete(projectId);
    const pending = this.pending.get(projectId);
    if (pending) {
      for (const [, req] of pending) {
        clearTimeout(req.timeout);
        req.reject(new Error("Engine transport disposed"));
      }
      this.pending.delete(projectId);
    }
    // Do NOT delete view registrations here; engine lifecycle is independent of views.
  }

  registerView(projectId: string, panel: vscode.WebviewPanel): void {
    let set = this.views.get(projectId);
    if (!set) {
      set = new Set();
      this.views.set(projectId, set);
    }
    if (set.has(panel)) {
      return;
    }
    set.add(panel);

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        this.handleViewMessage(projectId, raw);
      }),
    );
    disposables.push(
      panel.onDidDispose(() => {
        this.unregisterView(projectId, panel);
        for (const d of disposables) {
          d.dispose();
        }
      }),
    );
  }

  unregisterView(projectId: string, panel: vscode.WebviewPanel): void {
    const set = this.views.get(projectId);
    if (set) {
      set.delete(panel);
      if (set.size === 0) {
        this.views.delete(projectId);
      }
    }
  }

  getViews(projectId: string): vscode.WebviewPanel[] {
    const set = this.views.get(projectId);
    return set ? Array.from(set) : [];
  }

  findView(projectId: string, viewType: string): vscode.WebviewPanel | undefined {
    const set = this.views.get(projectId);
    if (!set) return undefined;
    for (const panel of set) {
      if (panel.viewType === viewType) {
        return panel;
      }
    }
    return undefined;
  }

  routeToEngine(projectId: string, message: Omit<MessageEnvelope, "direction">): void {
    const transport = this.engines.get(projectId);
    if (!transport) {
      this.outputChannel.appendLine(
        `[router] no engine for project ${projectId} (dropping ${message.type})`,
      );
      return;
    }
    const envelope: MessageEnvelope = { ...message, direction: "host-to-engine" };
    try {
      transport.postMessage(envelope);
    } catch (error) {
      this.outputChannel.appendLine(
        `[router] failed to post to engine ${projectId}: ${String(error)}`,
      );
    }
  }

  routeToViews(projectId: string, message: Omit<MessageEnvelope, "direction">): void {
    const envelope: MessageEnvelope = { ...message, direction: "host-to-view" };
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(panel.webview.postMessage(envelope)).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to post to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  broadcastToViews(projectId: string, message: HostMessage): void {
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(panel.webview.postMessage(message)).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to broadcast to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  private routeErrorToViews(projectId: string, text: string): void {
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(
        panel.webview.postMessage({
          type: "host/error",
          message: text,
        }),
      ).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to post error to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  async requestEngine(
    projectId: string,
    type: string,
    payload: unknown,
    options: { responseType?: string; timeoutMs?: number } = {},
  ): Promise<MessageEnvelope> {
    const transport = this.engines.get(projectId);
    if (!transport) {
      throw new Error(`No engine transport for project ${projectId}`);
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = options.timeoutMs ?? 10000;

    return new Promise<MessageEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.clearPending(projectId, requestId);
        reject(new Error(`Engine request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve,
        reject,
        timeout,
        responseType: options.responseType,
      };

      let map = this.pending.get(projectId);
      if (!map) {
        map = new Map();
        this.pending.set(projectId, map);
      }
      map.set(requestId, pending);

      const envelope: MessageEnvelope = {
        projectId,
        direction: "host-to-engine",
        type,
        payload,
        requestId,
      };
      try {
        transport.postMessage(envelope);
      } catch (error) {
        this.clearPending(projectId, requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private clearPending(projectId: string, requestId: string): void {
    const map = this.pending.get(projectId);
    if (!map) return;
    const req = map.get(requestId);
    if (req) {
      clearTimeout(req.timeout);
      map.delete(requestId);
    }
    if (map.size === 0) {
      this.pending.delete(projectId);
    }
  }

  private handleEngineMessage(projectId: string, raw: unknown): void {
    const parse = MessageSchema.safeParse(raw);
    if (!parse.success) {
      this.outputChannel.appendLine(`[router] invalid engine message: ${JSON.stringify(raw)}`);
      return;
    }
    const message = parse.data as MessageEnvelope;
    if (message.projectId !== projectId) {
      this.outputChannel.appendLine(
        `[router] engine message projectId mismatch: ${message.projectId} vs ${projectId}`,
      );
      return;
    }
    if (message.direction !== "engine-to-host") {
      this.outputChannel.appendLine(
        `[router] unexpected engine message direction: ${message.direction}`,
      );
      return;
    }

    // Resolve pending requests first.
    if (message.requestId) {
      const resolved = this.tryResolvePending(projectId, message);
      if (resolved) return;
      this.outputChannel.appendLine(
        `[router] dropping unmatched engine response: ${message.type} ${message.requestId}`,
      );
      return;
    }

    if (message.type === MessageType.EngineReady) {
      this.callbacks.onEngineReady(projectId, message.payload);
      return;
    }
    if (message.type === MessageType.EngineError) {
      this.callbacks.onEngineError(projectId, message.payload);
      const text =
        typeof message.payload === "object" && message.payload !== null
          ? ((message.payload as { message?: string }).message ?? JSON.stringify(message.payload))
          : String(message.payload);
      this.routeErrorToViews(projectId, text);
      return;
    }

    if (
      message.type === MessageType.StateUpdate ||
      message.type === MessageType.TransportPositionChanged
    ) {
      this.callbacks.onEngineStateUpdate(projectId, message);
      return;
    }

    // Broadcast engine state to all views for this project.
    this.routeToViews(projectId, {
      projectId,
      type: message.type,
      payload: message.payload,
      requestId: message.requestId,
    });
  }

  private tryResolvePending(projectId: string, message: MessageEnvelope): boolean {
    const map = this.pending.get(projectId);
    if (!map || !message.requestId) return false;
    const req = map.get(message.requestId);
    if (!req) return false;

    if (req.responseType && req.responseType !== message.type) {
      this.outputChannel.appendLine(
        `[router] response type mismatch for ${message.requestId}: expected ${req.responseType}, got ${message.type}`,
      );
      return true;
    }

    clearTimeout(req.timeout);
    map.delete(message.requestId);
    if (map.size === 0) {
      this.pending.delete(projectId);
    }
    req.resolve(message);
    return true;
  }

  private handleViewMessage(projectId: string, raw: unknown): void {
    if (raw === null || typeof raw !== "object" || !("type" in raw)) {
      this.outputChannel.appendLine(`[router] invalid view message: ${JSON.stringify(raw)}`);
      return;
    }

    const viewMessage = raw as ViewMessage;

    // Lifecycle/UI-only messages are not forwarded to the engine.
    if (viewMessage.type === "view/ready") {
      return;
    }

    if (viewMessage.type === "timeline/selectRegion") {
      this.callbacks.onViewSelection?.(projectId, viewMessage.regionId ?? null);
      return;
    }

    if (viewMessage.type === "command/importAudio") {
      void vscode.commands.executeCommand("vsdaw.importAudio");
      return;
    }

    if (viewMessage.type === "command/importMidi") {
      void vscode.commands.executeCommand("vsdaw.importMidi");
      return;
    }

    const envelope = adaptViewMessage(projectId, viewMessage);
    if (!envelope) {
      const reason = `unsupported view message type: ${viewMessage.type}`;
      this.outputChannel.appendLine(`[router] ${reason}`);
      this.routeErrorToViews(projectId, reason);
      return;
    }

    const parse = MessageSchema.safeParse(envelope);
    if (!parse.success) {
      this.outputChannel.appendLine(`[router] invalid adapted envelope: ${parse.error.message}`);
      return;
    }
    const message = parse.data as MessageEnvelope;
    if (message.projectId !== projectId) {
      this.outputChannel.appendLine(
        `[router] adapted envelope projectId mismatch: ${message.projectId} vs ${projectId}`,
      );
      return;
    }
    if (message.direction !== "host-to-engine") {
      this.outputChannel.appendLine(
        `[router] unexpected adapted envelope direction: ${message.direction}`,
      );
      return;
    }

    this.callbacks.onViewMessage(projectId, message);

    this.routeToEngine(projectId, {
      projectId,
      type: message.type,
      payload: message.payload,
      requestId: message.requestId,
    });
  }
}
src/engine/projectAdapter.ts:526:  addNote(
src/engine/messageHandlers.ts:10:  type MidiAddNotePayload,
src/engine/messageHandlers.ts:347:    case MessageType.MidiAddNote: {
src/engine/messageHandlers.ts:348:      const opts = p as MidiAddNotePayload;
src/engine/messageHandlers.ts:361:      const id = controller.addNote(
src/extension/viewMessageAdapter.ts:196:    case "pianoRoll/addNote":
src/extension/projectManager.ts:840:        type: MessageType.MidiAddNote,
src/shared/protocol.ts:128:  MidiAddNote = "midi.addNote",
src/shared/protocol.ts:296:export interface MidiAddNotePayload {

exec
/bin/zsh -lc "sed -n '520,580p' src/engine/projectAdapter.ts && sed -n '330,370p' src/engine/messageHandlers.ts && sed -n '280,315p' src/shared/protocol.ts" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
  }

  // ---------------------------------------------------------------------------
  // MIDI notes
  // ---------------------------------------------------------------------------

  addNote(
    regionId: string,
    position: number,
    duration: number,
    pitch: number,
    velocity: number,
  ): string {
    const region = this.resolveNoteRegion(regionId);
    const collection = region.optCollection.unwrap("Region has no note collection");
    const note = collection.createEvent({
      position,
      duration,
      pitch,
      velocity,
      cent: 0,
      chance: 100,
      playCount: 1,
    });
    this.broadcastState();
    return UUID.toString(note.uuid);
  }

  moveNote(noteId: string, position?: number, pitch?: number) {
    const note = this.resolveNote(noteId);
    this.boxGraph.beginTransaction();
    if (position !== undefined) note.box.position.setValue(position);
    if (pitch !== undefined) note.box.pitch.setValue(pitch);
    this.boxGraph.endTransaction();
    this.broadcastState();
  }

  resizeNote(noteId: string, duration: number) {
    const note = this.resolveNote(noteId);
    note.box.duration.setValue(duration);
    this.broadcastState();
  }

  deleteNote(noteId: string) {
    const note = this.resolveNote(noteId);
    note.box.delete();
    this.broadcastState();
  }

  setNoteVelocity(noteId: string, velocity: number) {
    const note = this.resolveNote(noteId);
    note.box.velocity.setValue(velocity);
    this.broadcastState();
  }

  handleMidiInput(deviceId: string, data: Uint8Array, timestamp: number) {
    if (data.length < 1) return;

    // Forward the raw MIDI event through the SDK's software MIDI input so that
    // armed captures (audio-unit inputs) and the engine's own routing pick it
    // up with correct latency/timing. This replaces the previous direct
      const opts = p as RegionFadePayload;
      if (!opts?.regionId || opts.value == null) {
        return { type: "error", message: "regionId and value are required" };
      }
      controller.setFadeOut(opts.regionId, opts.value);
      return { type: "ok" };
    }
    case MessageType.RegionDelete: {
      const opts = p as RegionIdPayload;
      if (!opts?.regionId) {
        return { type: "error", message: "regionId is required" };
      }
      controller.deleteRegion(opts.regionId);
      return { type: "ok" };
    }

    // MIDI
    case MessageType.MidiAddNote: {
      const opts = p as MidiAddNotePayload;
      if (
        !opts?.regionId ||
        opts.position == null ||
        opts.duration == null ||
        opts.pitch == null ||
        opts.velocity == null
      ) {
        return {
          type: "error",
          message: "regionId, position, duration, pitch and velocity are required",
        };
      }
      const id = controller.addNote(
        opts.regionId,
        opts.position,
        opts.duration,
        opts.pitch,
        opts.velocity,
      );
      return { type: "ok", payload: { noteId: id } };
    }
    case MessageType.MidiMoveNote: {
}

export interface RegionSplitPayload {
  regionId: string;
  position: number;
}

export interface RegionFadePayload {
  regionId: string;
  value: number;
}

export interface RegionIdPayload {
  regionId: string;
}

export interface MidiAddNotePayload {
  regionId: string;
  position: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface MidiMoveNotePayload {
  noteId: string;
  position?: number;
  pitch?: number;
}

export interface MidiResizeNotePayload {
  noteId: string;
  duration: number;
}

export interface MidiNoteIdPayload {

exec
/bin/zsh -lc "sed -n '1,160p' src/extension/commands.ts && sed -n '160,260p' src/extension/commands.ts && grep -R \"command/export\\|command/show\" -n src/extension src/views tests | head -100" in /Users/user/Projects/vsdaw
 succeeded in 0ms:
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MessageType } from "../shared/protocol.js";
import type { PlaywrightEngineManager } from "./playwrightEngine.js";
import type { ProjectManager } from "./projectManager.js";
import type {
  BrowserWebviewProvider,
  GraphWebviewProvider,
  MixerWebviewProvider,
  PianoRollWebviewProvider,
} from "./views/index.js";

export interface CommandDependencies {
  context: vscode.ExtensionContext;
  projectManager: ProjectManager;
  engineManager: PlaywrightEngineManager;
  mixerProvider: MixerWebviewProvider;
  pianoRollProvider: PianoRollWebviewProvider;
  browserProvider: BrowserWebviewProvider;
  graphProvider: GraphWebviewProvider;
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { projectManager } = deps;
  const outputChannel = projectManager.outputChannel;
  const disposables: vscode.Disposable[] = [];

  const register = (command: string, handler: () => Promise<void> | void) => {
    disposables.push(
      vscode.commands.registerCommand(command, async () => {
        try {
          await handler();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outputChannel.appendLine(`[command:${command}] error: ${message}`);
          if (!(error instanceof vscode.CancellationError)) {
            vscode.window.showErrorMessage(`VSDAW: ${message}`);
          }
        }
      }),
    );
  };

  register("vsdaw.newProject", () => projectManager.newProject());
  register("vsdaw.openProject", () => projectManager.openProject());

  register("vsdaw.showTimeline", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    const session = projectManager.getSession(projectId);
    if (!session) return;
    const timeline = session.views.get("vsdaw.editor");
    if (timeline) {
      timeline.reveal(vscode.ViewColumn.One);
    } else {
      await vscode.commands.executeCommand("vscode.openWith", session.uri, "vsdaw.editor", {
        preview: false,
      });
    }
  });

  register("vsdaw.showMixer", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.mixerProvider.show(projectId);
  });

  register("vsdaw.showPianoRoll", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.pianoRollProvider.show(projectId);
  });

  register("vsdaw.showBrowser", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.browserProvider.show(projectId);
  });

  register("vsdaw.showGraph", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.graphProvider.show(projectId);
  });

  register("vsdaw.importAudio", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        "Audio Files": ["wav", "aiff", "flac", "mp3", "ogg", "m4a"],
        "All Files": ["*"],
      },
      openLabel: "Import Audio",
    });
    if (!uris || uris.length === 0) return;

    await projectManager.importAudio(uris[0]);
  });

  register("vsdaw.importMidi", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        "MIDI Files": ["mid", "midi"],
        "All Files": ["*"],
      },
      openLabel: "Import MIDI",
    });
    if (!uris || uris.length === 0) return;

    await projectManager.importMidi(uris[0]);
  });

  register("vsdaw.export", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const format = await vscode.window.showQuickPick(["wav", "flac", "ogg"], {
      placeHolder: "Select export format",
    });
    if (!format) return;

    const config = vscode.workspace.getConfiguration("vsdaw");
    const defaultDir = config.get<string>("export.defaultDirectory", "${workspaceFolder}/exports");
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let dir = defaultDir;
    if (workspacePath) {
      dir = dir.replace("${workspaceFolder}", workspacePath);
    } else if (dir.includes("${workspaceFolder}")) {
      dir = path.join(os.homedir(), "exports");
    }
    if (!path.isAbsolute(dir)) {
      dir = path.join(workspacePath ?? os.homedir(), dir);
    }

    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, `export.${format}`)),
      filters: { [format.toUpperCase()]: [format] },
      saveLabel: "Export",
    });
    if (!destination) return;

    await projectManager.router.requestEngine(
      projectId,
      MessageType.ExportRender,
      {
        format: format as "wav" | "flac" | "ogg",
        fileName: destination.fsPath,
        fileName: destination.fsPath,
        start: 0,
        end: 0,
        stems: false,
      },
      { responseType: `${MessageType.ExportRender}.ack`, timeoutMs: 120000 },
    );

    vscode.window.showInformationMessage(`VSDAW export to ${destination.fsPath} complete`);
  });

  register("vsdaw.settings", () => {
    void vscode.commands.executeCommand("workbench.action.openSettings", "vsdaw");
  });

  register("vsdaw.engineHealth", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const origin = projectManager.getServerOrigin();
    if (!origin) {
      throw new Error("Engine server is not running");
    }

    const result = await deps.engineManager.healthCheck(projectId, origin);
    vscode.window.showInformationMessage(`VSDAW engine is healthy (${result.elapsedMs}ms).`);
  });

  register("vsdaw.showEngineMenu", async () => {
    const { engineManager } = deps;
    const running = engineManager.isRunning;
    const items: vscode.QuickPickItem[] = [
      {
        label: running ? "$(debug-stop) Stop Engine" : "$(play) Start Engine",
        description: running
          ? "Stop the background Chrome audio engine"
          : "Launch background Chrome audio engine",
      },
      {
        label: "$(debug-restart) Restart Engine",
        description: "Restart the background Chrome audio engine",
      },
      {
        label: "$(pulse) Engine Health",
        description: "Ping the audio engine and show response time",
      },
      { label: "$(output) Show Output", description: "Open the VSDAW output channel" },
      { label: "$(gear) Open Settings", description: "Open VSDAW settings" },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `VSDAW Engine — ${running ? "running" : "stopped"}`,
    });
    if (!picked) return;

    if (picked.label.includes("Stop Engine")) {
      await engineManager.stop();
    } else if (picked.label.includes("Start Engine")) {
      await engineManager.start();
    } else if (picked.label.includes("Restart Engine")) {
      await engineManager.stop();
      await engineManager.start();
    } else if (picked.label.includes("Engine Health")) {
      await vscode.commands.executeCommand("vsdaw.engineHealth");
    } else if (picked.label.includes("Show Output")) {
      outputChannel.show();
    } else if (picked.label.includes("Open Settings")) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "vsdaw");
    }
  });

  return disposables;
}

function getActiveProjectId(projectManager: ProjectManager): string | undefined {
  const projectId = projectManager.getActiveProjectId();
  if (projectId) return projectId;

  void vscode.window.showInformationMessage(
    "No active VSDAW project. Open or create a project first.",
  );
  return undefined;
}
src/extension/viewMessageAdapter.ts:204:    case "command/export":
src/extension/viewMessageAdapter.ts:207:    case "command/show":
src/views/shared/types.ts:102:  | { type: "command/export" }
src/views/shared/types.ts:105:  | { type: "command/show"; view: ViewName };
src/views/shared/useViewState.ts:126:    export: () => send({ type: "command/export" }),
src/views/shared/useViewState.ts:129:    showView: (target: ViewName) => send({ type: "command/show", view: target }),
tests/unit/viewMessageAdapter.test.ts:289:      { type: "command/export" },
tests/unit/viewMessageAdapter.test.ts:290:      { type: "command/show", view: "mixer" },

