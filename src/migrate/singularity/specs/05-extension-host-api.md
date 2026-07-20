# 05 — Extension Host API

## Goal

Implement the VS Code extension host that coordinates projects, the local server, view tabs, and the message bus.

## Entry point

`src/extension/extension.ts`

- `activate(context: ExtensionContext)` registers commands, custom editors, webview providers, and project manager.
- `deactivate()` closes all projects and stops the server.

## Commands

All commands are prefixed `vsdaw.`.

| Command ID | Title | Behavior |
|---|---|---|
| `vsdaw.newProject` | VSDAW: New Project | Create untitled project in workspace root or user-selected folder. |
| `vsdaw.openProject` | VSDAW: Open Project | Show file picker for `.vsdaw` files. |
| `vsdaw.showTimeline` | VSDAW: Show Timeline | Open or focus Timeline for active project. |
| `vsdaw.showMixer` | VSDAW: Show Mixer | Open or focus Mixer. |
| `vsdaw.showPianoRoll` | VSDAW: Show Piano Roll | Open or focus Piano Roll. |
| `vsdaw.showBrowser` | VSDAW: Show Browser | Open or focus Browser. |
| `vsdaw.showGraph` | VSDAW: Show Graph | Open or focus routing graph. |
| `vsdaw.export` | VSDAW: Export Audio | Trigger export dialog and render. |
| `vsdaw.settings` | VSDAW: Open Settings | Open VSDAW settings page. |

## Custom editor

- `src/extension/editor/vsdawEditor.ts`
- Registered for `*.vsdaw` files.
- `resolveCustomEditor(document, webviewPanel, token)` creates a project session and loads the Timeline view into the panel.

## Settings

VS Code configuration namespace `vsdaw`:

```json
{
  "vsdaw.audio.defaultSampleRate": 48000,
  "vsdaw.audio.defaultBufferSize": 128,
  "vsdaw.audio.inputDeviceId": null,
  "vsdaw.audio.outputDeviceId": null,
  "vsdaw.autoSave": true,
  "vsdaw.autoSaveDelay": 500,
  "vsdaw.recording.countInBars": 1,
  "vsdaw.export.defaultDirectory": "${workspaceFolder}/exports"
}
```

## Project manager

`src/extension/projectManager.ts`

- Maintains a map of `projectId -> ProjectSession`.
- Handles new, open, close, save, auto-save, recovery.
- Persists recovery data to `ExtensionContext.workspaceState` / global storage.

## Local server

`src/extension/server.ts`

- `start(): Promise<number>` starts `Bun.serve` and returns the port.
- `stop(): Promise<void>` stops the server.
- Serves static files from `out/webview/`.
- Injects COOP/COEP/CORP headers.
- Logs requests in debug mode.

## Message router

`src/extension/messageRouter.ts`

- Routes messages based on `projectId` and `direction`.
- Maintains references to engine webview and view webviews per project.
- Validates message shape with Zod schemas.
- Handles engine lifecycle messages (`engine.ready`, `engine.error`).

## Webview providers

- `TimelineCustomEditorProvider`
- `MixerWebviewProvider`
- `PianoRollWebviewProvider`
- `BrowserWebviewProvider`
- `GraphWebviewProvider`

Each provider creates a webview, sets CSP, injects the React bundle URL, and registers message listeners.

## Hidden engine webview

`src/extension/engineWebview.ts`

- Creates a hidden webview panel with `ViewColumn.Beside` or `ViewColumn.One` and immediately hides it.
- Loads the engine iframe URL.
- Disposes on project close.

## File I/O

- Use VS Code `workspace.fs` for file operations.
- ZIP read/write via `jszip`.
- Audio file decoding/encoding delegated to engine where possible.

## Acceptance criteria

1. All commands appear in the command palette.
2. Opening a `.vsdaw` file creates exactly one engine session and one Timeline view.
3. Multiple projects can be open simultaneously, each isolated.
4. Settings changes propagate to the engine.
5. Extension deactivation closes all resources cleanly.
