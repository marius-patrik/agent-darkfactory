# 00 — Overview

## Mission

VSDAW is a public release-ready Visual Studio Code extension that embeds the OpenDAW audio engine into the editor as a set of first-class, movable IDE tabs. It lets developers and musicians compose, record, edit, mix, and export music without leaving their workspace.

## Scope

### In scope for v1.0

- OpenDAW SDK-based custom UI running inside VS Code.
- Movable VS Code tabs for Timeline, Mixer, Piano Roll, Device Browser, and optional Graph view.
- Hidden engine webview per open `.vsdaw` project owning the OpenDAW `Project`, `AudioContext`, workers, and worklets.
- Project persistence using an OpenDAW-compatible `.vsdaw` JSZip bundle.
- Transport: play/pause/stop/record/seek, loop, tempo, time signature.
- Audio and MIDI recording with multi-take support.
- Audio/MIDI file import.
- Per-track insert effects using OpenDAW stock devices.
- Offline export to WAV, FLAC, OGG; MP3 and stems as stretch goals.
- Auto-save, crash recovery, and workspace integration.
- Native VS Code theming, keyboard shortcuts, and command palette integration.

### Out of scope for v1.0 (roadmap)

- VST/AU plugin hosting.
- FL Studio-style channel rack / step sequencer (unless trivially built on SDK).
- Real-time collaboration.
- Cloud project storage.
- Mobile or web-version-of-VS-Code support.
- Full FL Studio feature parity.

## Glossary

| Term | Meaning |
|---|---|
| **OpenDAW SDK** | `@opendaw/studio-sdk`, `@opendaw/studio-core`, and related packages. |
| **Engine webview** | Hidden VS Code webview that owns the OpenDAW audio engine for a project. |
| **View tab** | Visible VS Code tab/webview showing a DAW component (Timeline, Mixer, etc.). |
| **Message bus** | Extension-host-mediated `postMessage` protocol connecting engine and views. |
| **`.vsdaw`** | Project file: a JSZip bundle containing `project.json` and an `audio/` folder. |

## Non-goals

- Re-implement OpenDAW's DSP. All audio processing delegates to the SDK.
- Support browsers or VS Code for the Web in v1.0 (Desktop only).
- Collect telemetry or require user accounts.

## Acceptance criteria

1. A user can install the `.vsix` locally, open a workspace, and create a new `.vsdaw` project.
2. The project opens in the Timeline custom editor and can spawn Mixer / Piano Roll / Browser tabs.
3. The user can import audio, record audio/MIDI, arrange regions, apply effects, and export a mix.
4. Save/reload round-trips correctly.
5. CI passes and a signed `.vsix` artifact is produced on every tag.
