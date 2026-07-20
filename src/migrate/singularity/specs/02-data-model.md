# 02 — Data Model

## Goal

Define a portable, OpenDAW-compatible project file format and persistence strategy.

## `.vsdaw` bundle format

A `.vsdaw` file is a ZIP archive (DEFLATE compression) containing:

```
project.vsdaw
├── project.json
├── audio/
│   ├── <uuid>.wav
│   └── ...
└── assets/
    └── (optional future: presets, soundfonts, etc.)
```

### `project.json` schema

```json
{
  "$schema": "vsdaw://project.json/v1",
  "version": "1.0.0",
  "createdBy": "vsdaw",
  "createdAt": "2026-06-25T15:00:00Z",
  "project": {
    "name": "Untitled",
    "sampleRate": 48000,
    "tempo": 120.0,
    "timeSignature": [4, 4],
    "loop": { "enabled": false, "start": 0, "end": 0 }
  },
  "tracks": [
    {
      "id": "track-1",
      "name": "Audio 1",
      "type": "audio",
      "color": "#3b82f6",
      "volumeDb": 0.0,
      "pan": 0.0,
      "mute": false,
      "solo": false,
      "arm": false,
      "inserts": []
    }
  ],
  "regions": [
    {
      "id": "region-1",
      "trackId": "track-1",
      "audioFile": "audio/<uuid>.wav",
      "start": 0,
      "duration": 192000,
      "offset": 0,
      "fadeIn": { "type": "linear", "duration": 0 },
      "fadeOut": { "type": "linear", "duration": 0 }
    }
  ],
  "midiClips": [],
  "automation": [],
  "mixer": {
    "masterVolumeDb": 0.0
  }
}
```

All time values for audio are in samples. MIDI and musical values use PPQN (pulses per quarter note) where appropriate.

## Serialization strategy

- The extension host owns the canonical project file on disk.
- The engine webview owns the runtime OpenDAW project state.
- On save:
  1. Host sends `project.serialize` to engine.
  2. Engine returns a JSON snapshot compatible with `project.json`.
  3. Host writes the snapshot and any new/updated audio files to a temporary `.vsdaw` bundle.
  4. Host atomically replaces the original file.
- On load:
  1. Host reads the ZIP, extracts `project.json` and `audio/` to a temporary working directory.
  2. Host sends `project.load` to engine with the JSON and audio file paths/URIs.
  3. Engine reconstructs the OpenDAW project.

## Auto-save and recovery

- Auto-save triggers on meaningful edits: region move/resize, track add/delete, effect parameter change, recording stop.
- Debounced 500 ms after the last edit.
- Periodic full backup every 60 seconds while playing/recording.
- Recovery file: `.vsdaw/.recovery/<projectId>-<timestamp>.vsdaw` inside the workspace storage path.
- On extension startup, if recovery files exist, show a recovery picker.

## Workspace integration

- `.vsdaw` files use a VS Code custom editor.
- Opening a `.vsdaw` file from the Explorer creates a project session.
- Project-relative sample references are resolved relative to the workspace root.
- Imported samples are copied into the bundle's `audio/` folder.

## Acceptance criteria

1. A saved `.vsdaw` file can be reopened and produce identical project state.
2. Audio files inside the bundle are lossless WAV.
3. Auto-save does not block the UI thread.
4. Recovery flow restores unsaved changes after a crash.
