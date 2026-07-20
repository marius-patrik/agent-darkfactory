# Data/Persistence Review Summary

## Scope

- `src/shared/bundle.ts`
- `src/shared/schemas.ts`
- `src/shared/time.ts`
- `src/shared/peaks.ts`
- `src/extension/projectManager.ts` (persistence logic)
- Related touch points: `src/extension/types.ts`, `src/extension/extension.ts`, `src/extension/editor/vsdawEditor.ts`

## Bugs Found and Fixed

### 1. `.vsdaw` save/load format mismatch

**Problem:** `writeEmptyProject` created a ZIP bundle containing only `project.json`, but `loadProjectIntoSession` sent the raw bundle bytes to the engine as an OpenDAW binary. The engine's `Project.load` expected its own SDK serialization, so empty projects and any bundle-only file could not be reopened.

**Fix:**
- `bundle.ts` now supports an optional `engine.bin` entry that stores the OpenDAW SDK serialization.
- `projectManager.ts` save path wraps the engine bytes in a bundle (`project.json` + `engine.bin`) and writes atomically.
- `projectManager.ts` load path reads the bundle, validates `project.json`, and either sends `engine.bin` to the engine via `ProjectLoad` or sends `ProjectNew` for empty bundles.

### 2. Pending engine messages never flushed

**Problem:** `projectManager.onEngineReady` existed but `extension.ts` set `session.engineReady` directly, so queued `ProjectLoad` / `ProjectNew` messages were never sent.

**Fix:** `extension.ts` now calls `projectManager.onEngineReady()`, which flushes `pendingEngineMessages`.

### 3. No project.json validation on read/write

**Problem:** `readBundle` cast the parsed JSON to `ProjectJson` without validation. `writeBundle` also wrote whatever it received.

**Fix:** Both functions now run `projectJsonSchema.safeParse()` and throw a descriptive `BundleError` on failure.

### 4. Unsafe audio file paths

**Problem:** `writeBundle` allowed keys like `audio/../../evil.wav`, which could escape the `audio/` folder inside the ZIP.

**Fix:** Added `sanitizeAudioPath` that rejects traversal, absolute paths, hidden names, nested folders, and non-filename characters.

### 5. Auto-save could race and corrupt files

**Problem:** Multiple overlapping auto-saves were possible, and the temporary file was not cleaned up on write failure.

**Fix:**
- Added `session.isSaving` guard in `saveSession` and `writeRecoveryBackup`.
- Atomic save now deletes the temporary file if `rename` fails.
- Validates `autoSaveDelay` before scheduling.

### 6. Recovery files were not actually restored

**Problem:** `offerRecovery` only opened the recovery folder. There was no restore flow, metadata, or cleanup.

**Fix:**
- `writeRecoveryBackup` writes a sidecar `.json` with the original URI, project name, and timestamp.
- `offerRecovery` shows a picker, cleans up files older than 7 days, copies the selected recovery file to a user-chosen location, and removes the consumed recovery files.

### 7. Schema gaps

**Problem:**
- `version` accepted any string.
- `audioFile` accepted any string, not just safe `audio/` paths.
- Time/peaks utilities lacked input validation.

**Fix:**
- `version` now requires `MAJOR.MINOR.PATCH`.
- `audioFile` regex restricts it to `audio/<safe-name>.<ext>`.
- `time.ts` validates sample rate, tempo, PPQN, and time signatures; rejects negative/finite bars/beats/ticks.
- `peaks.ts` validates `AudioBuffer` dimensions, `Float32Array` input, and integer peak counts.

### 8. Workspace integration issues

**Problem:**
- New projects outside a workspace defaulted to `vscode.env.appRoot` (system directory).
- `saveCustomDocumentAs` mutated `session.uri` directly without updating the URI-to-session map.

**Fix:**
- Default save location now uses the extension's global storage directory or the user's home directory.
- `saveCustomDocumentAs` uses `projectManager.updateSessionUri()`.

## Files Changed

- `src/shared/bundle.ts`
- `src/shared/schemas.ts`
- `src/shared/time.ts`
- `src/shared/peaks.ts`
- `src/extension/projectManager.ts`
- `src/extension/types.ts`
- `src/extension/extension.ts`
- `src/extension/editor/vsdawEditor.ts`
- `tests/unit/projectRoundTrip.test.ts`

## Verification

- `bun run build` — passes
- `bun run test` — 72 tests pass across 7 suites
- `npx biome check` on modified files — clean

## Notes

- The canonical `.vsdaw` format is now a ZIP bundle containing `project.json` plus an optional `engine.bin` (OpenDAW SDK serialization). Audio files live under `audio/`.
- Engine source (`src/engine/*`) was not modified for data fixes; the engine still uses its native `Project.load` / `toArrayBuffer` serialization, which the host now wraps/unwraps in the bundle format.
