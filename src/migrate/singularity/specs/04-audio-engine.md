# 04 — Audio Engine

## Goal

Integrate the OpenDAW SDK into the hidden engine webview and expose all audio operations to view tabs via the message bus.

## SDK packages

Primary dependencies:

- `@opendaw/studio-sdk`
- `@opendaw/studio-core`
- `@opendaw/studio-adapters`
- `@opendaw/lib-dsp`
- `@opendaw/lib-std`
- `@opendaw/lib-runtime`

Pin to the latest stable version available at build time. Document the pinned version in `README.md`.

## Engine boot sequence

1. Iframe HTML loads `engine.tsx`.
2. Assert `crossOriginIsolated === true`.
3. Install workers: `Workers.install(WorkersUrl)`.
4. Install audio worklets: `AudioWorklets.install(WorkletsUrl)`.
5. Create `AudioContext({ latencyHint: 0 })`.
6. Create worklets for the context.
7. Create sample manager and soundfont manager.
8. Create OpenDAW `Project`.
9. Start audio worklet.
10. Send `engine.ready` to extension host.

Worker and worklet URLs must be served from the local Bun server with correct MIME types and COOP/COEP headers.

## Project lifecycle

- `project.new`: create empty project with default tempo/time signature.
- `project.load`: deserialize from `project.json` + audio files.
- `project.serialize`: return current project state as `project.json`-compatible JSON.
- `project.close`: dispose project, close AudioContext, release resources.

## Transport

- `transport.play`
- `transport.pause`
- `transport.stop`
- `transport.record`
- `transport.seek` (position in samples or bars/beats)
- `transport.setLoop` (start, end, enabled)
- `transport.setTempo`
- `transport.setTimeSignature`

Engine broadcasts `transport.stateChanged` and `transport.positionChanged` to all views.

## Tracks

- `track.create` (type: audio | midi | bus)
- `track.delete`
- `track.reorder`
- `track.setName`, `track.setColor`
- `track.setVolumeDb`, `track.setPan`
- `track.setMute`, `track.setSolo`, `track.setArm`
- `track.addInsert`, `track.removeInsert`, `track.moveInsert`, `track.setInsertParameter`

## Regions and clips

- `region.createAudio` (trackId, audioFile, start, duration, offset)
- `region.createMidi` (trackId, start, duration)
- `region.move`, `region.resize`, `region.split`
- `region.setFadeIn`, `region.setFadeOut`
- `region.delete`

## MIDI

- `midi.addNote`, `midi.moveNote`, `midi.resizeNote`, `midi.deleteNote`
- `midi.setNoteVelocity`
- MIDI input via WebMidi.js forwarded to engine as `midi.input` messages.

## Recording

- `recording.start` (trackIds, count-in options)
- `recording.stop`
- Engine creates takes per armed track.
- `recording.comp` to select/active take regions.

## Mixer / effects

- Insert slots hold OpenDAW device instances.
- `device.create` (factory name), `device.delete`
- `device.setParameter` (parameter path, value)
- Optional graph view maps to SDK's internal signal graph where exposed.

## Waveform peaks

- Generate peaks in a Web Worker using `OffscreenCanvas` or raw Float32Array analysis.
- Cache peaks keyed by audio file UUID.
- Expose `peaks.get` API to views.

## Export

- `export.render` (start, end, format, options)
- Formats: WAV, FLAC, OGG. MP3 and stems as stretch goals.
- Use OpenDAW offline rendering when available; otherwise use `OfflineAudioContext`.
- Save rendered file to workspace via extension host.

## Error handling

- Engine catches SDK errors and sends `engine.error` to host.
- Host shows user-facing notification and logs to output channel.
- AudioContext suspension on user gesture required: engine listens for first click and resumes.

## Acceptance criteria

1. Engine boots and reports `ready` within 3 seconds on a modern machine.
2. Playhead advances smoothly during playback.
3. Recording creates audio/MIDI regions that appear in the timeline.
4. Export produces a valid audio file.
5. CPU usage stays below 30% during 8-track playback with effects.
