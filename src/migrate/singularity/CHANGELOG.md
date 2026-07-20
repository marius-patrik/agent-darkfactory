# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-27

### Added

- Piano roll note editing (create, move, resize, delete, velocity) (#21).
- Mixer routing: per-track output selector and send protocol/UI foundation (#22).
- Automation lanes and envelope point editing on the timeline (#23).
- Audio input device selection for recording on audio tracks (#24).
- Timeline zoom slider / Ctrl+wheel zoom and snap-to-grid selector (#25).
- Plugin browser folder with scan protocol; native VST3/AU hosting stubbed (#26).

## [0.2.0] - 2026-06-27

### Added

- Background Chrome audio engine managed by a status-bar icon (Playwright + chrome-launcher).
- View-to-engine message protocol adapter and engine-state broadcast to views.
- Redesigned Timeline toolbar with view switcher, Add Track dropdown, Undo/Redo, Import, and Export.
- Track header controls wired end-to-end (mute, solo, arm, volume, pan, name).
- Audio and MIDI file import into the `.vsdaw` bundle.
- Device browser listing OpenDAW factory devices and a parameter panel for inserts.
- Undo/redo stack with `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`.
- Export audio to disk (WAV; FLAC/OGG/MP3 fallback).
- Save/load round-trip integration test and host commands for state/track/region access.
- GitHub milestone `v0.2.0 Public Beta` with issues #1–#10.
- Second-pass specs for FL Studio parity: piano roll, mixer routing, automation, recording, arranger, plugins.

## [0.1.0] - 2026-06-25

### Added

- Phase 0 audio engine spike using OpenDAW SDK inside a cross-origin isolated local Bun server.
- VS Code extension host with commands: New Project, Open Project, Show Timeline, Show Mixer, Show Piano Roll, Show Browser, Show Graph, Export Audio, and Open Settings.
- Custom editor provider for `.vsdaw` project bundles.
- Project bundle read/write utilities and JSON schema validation with Zod.
- Shared utilities: message protocol serialization, time conversion, peak generation, and project bundle handling.
- Jest unit tests for shared utilities with 70% line coverage threshold.
- Integration test scaffold using `@vscode/test-cli`.
- Smoke test script that installs the `.vsix` and verifies activation.
- CI workflow running lint, typecheck, unit tests, integration tests, and packaging on macOS, Ubuntu, and Windows.
- Release workflow triggered by tag pushes that builds a `.vsix`, creates a GitHub Release, and publishes to the VS Code Marketplace and Open VSX.
- Documentation: `docs/USAGE.md`, `CHANGELOG.md`, and `ThirdPartyNotices.txt`.

### Changed

- Updated `package.json` marketplace metadata (publisher, repository, icon, categories, keywords).

## [0.0.1] - 2026-06-25

### Added

- Initial repository scaffold with package.json, README, LICENSE, and Phase 0 build scripts.
