# VSDAW Usage Guide

VSDAW is a digital audio workstation (DAW) that runs inside Visual Studio Code using the OpenDAW engine.

## Getting Started

1. Install the extension from the `.vsix` file or from the VS Code Marketplace.
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **VSDAW: New Project**.
3. Save the `.vsdaw` file in your workspace.
4. The Timeline webview opens automatically and boots the audio engine.

## Opening an Existing Project

- Use **VSDAW: Open Project** from the Command Palette.
- Or double-click any `.vsdaw` file in the Explorer.

## Commands

All commands are prefixed with `VSDAW:` in the Command Palette.

| Command | Action |
|---|---|
| New Project | Create an empty `.vsdaw` project. |
| Open Project | Open an existing `.vsdaw` project. |
| Show Timeline | Open or focus the Timeline view. |
| Show Mixer | Open or focus the Mixer view. |
| Show Piano Roll | Open or focus the Piano Roll view. |
| Show Browser | Open or focus the Browser view. |
| Show Graph | Open or focus the routing graph view. |
| Export Audio | Render the project to an audio file. |
| Open Settings | Open VSDAW settings. |

## Project Files

A `.vsdaw` file is a ZIP bundle containing:

- `project.json` — project metadata, tracks, regions, and mixer state.
- `audio/` — embedded WAV audio files referenced by regions.

Keep audio files inside the bundle so the project remains portable.

## Settings

Open VS Code settings (`Cmd+,` / `Ctrl+,`) and search for **VSDAW**.

Key settings:

- `vsdaw.audio.defaultSampleRate` — default sample rate for new projects (default: 48000).
- `vsdaw.audio.defaultBufferSize` — audio buffer size (default: 128).
- `vsdaw.autoSave` — automatically save projects after edits (default: true).
- `vsdaw.recording.countInBars` — count-in bars before recording (default: 1).
- `vsdaw.export.defaultDirectory` — default export location (default: `${workspaceFolder}/exports`).

## Engine Requirements

The audio engine runs inside a cross-origin isolated local server. Make sure:

- Bun is installed and available on your system `PATH`.
- The local server port is not blocked by a firewall.
- `crossOriginIsolated === true` inside the engine webview (verified on activation).

## Troubleshooting

- **Engine fails to boot**: Check the VS Code Output panel and the local server logs.
- **No audio**: Verify your default audio output device and that the engine webview is focused.
- **Project won't save**: Ensure the workspace folder has write permissions.

## Keyboard Shortcuts

VSDAW contributes standard transport shortcuts where available. Customize them in VS Code keybindings.

## License

VSDAW is released under the AGPL-3.0-or-later license. See [LICENSE](../LICENSE) and [ThirdPartyNotices.txt](../ThirdPartyNotices.txt).
