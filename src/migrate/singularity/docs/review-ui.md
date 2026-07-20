# VSDAW UI/UX Review

**Scope:** `src/views/*`, `src/components/*`, `public/views/*`, `src/views/shared/global.css`, `tailwind.config.js`  
**Date:** 2026-06-25  
**Reviewer:** UI/UX review subagent

## Summary

The Timeline was reported to render "not properly". The root causes were:

1. The canvas was sized to `window.innerWidth` instead of its flex container, causing overflow and misalignment with the track-header sidebar.
2. There was no `ResizeObserver`, so the canvas never reacted to panel resizing.
3. HiDPI scaling was applied but the backing store was reset on every render without re-applying the transform, producing intermittent blur/clipping.
4. `onSeek` was a no-op placeholder, so timeline clicks did nothing.
5. Region moves were sent on every mouse-move event, spamming the extension host.

This review fixed the Timeline canvas, hardened all five views with error boundaries and empty states, repaired broken/missing event handlers, improved accessibility, and corrected theme-dependent rendering.

## Bugs Found & Fixes

### Timeline

| Bug | Fix |
|-----|-----|
| Canvas width used `window.innerWidth` instead of container width | Added `useCanvasSize` hook with `ResizeObserver` + window resize listener |
| Canvas did not re-scale on HiDPI or resize | Reset `ctx.setTransform`, set `width/height` to `size * dpr`, then `ctx.scale(dpr, dpr)` |
| `onSeek` was a no-op | Added `transport/seek` message type and wired `state.transport.seek` |
| Region drag flooded the message bus | Queue the move in a ref and flush only on `mouseup` |
| `positionBeats` assumed 4/4 | Calculate from `timeSignature.numerator` |
| Track headers used raw `track.height` (could be 0) | Enforce `MIN_TRACK_HEIGHT` (60px) |
| Track-header volume/pan had no value readouts | Added percentage / L-R-C labels |
| No empty state for empty project | Added `EmptyState` when `tracks.length === 0` |
| Keyboard handler re-bound on every state change | Memoized dependency list for `useEffect` |

### Mixer

| Bug | Fix |
|-----|-----|
| Master strip showed insert slots | Hidden insert slots when `isMaster` |
| Master color was hardcoded `#f0f0f0` | Read `--vsdaw-button-bg` at runtime |
| No empty state | Added `EmptyState` when no tracks |
| No error boundary | Wrapped view in `ErrorBoundary` |

### Piano Roll

| Bug | Fix |
|-----|-----|
| Piano keys used hardcoded `#1e1e1e`/`#f3f3f3` (invisible in some themes) | Use theme variables `--vsdaw-input-bg`/`--vsdaw-panel-bg` |
| Demo notes hardcoded in `useEffect` | Removed; grid now shows an instructional empty state |
| Note IDs could collide | Added monotonic counter suffix |
| No error boundary | Wrapped view in `ErrorBoundary` |
| Fixed 16-beat width was not scrollable | Added `minWidth` and `overflow: auto` on wrapper |

### Browser

| Bug | Fix |
|-----|-----|
| Empty folders showed nothing | Added empty-state message when root has no children |
| `.mid` check was case-sensitive | Use `toLowerCase().endsWith(".mid")` |
| Tree items not keyboard operable | Added `tabIndex`, arrow/enter/space handlers |
| No error boundary | Wrapped view in `ErrorBoundary` |

### Graph

| Bug | Fix |
|-----|-----|
| No empty state | Added "No routing nodes" label |
| No error boundary | Wrapped view in `ErrorBoundary` |

### Shared / Toolbar / Transport

| Bug | Fix |
|-----|-----|
| Toolbar overflow menu did not close on outside click | Added document `mousedown` listener |
| "Show tabs" overflow item showed current view | Changed to "Show timeline" |
| Time signature accepted invalid values (0, negative, non-power-of-two denominator) | Added `parseTimeSignature` validation |
| Tempo allowed non-finite/negative values | Added `clampBpm` helper |
| Several buttons lacked `type="button"` | Added explicit `type="button"` to all icon/menu buttons |

## Files Changed

### New

- `src/components/shared/ErrorBoundary.tsx` – class component error boundary for every view
- `src/components/shared/EmptyState.tsx` – reusable empty-state placeholder

### Modified

- `src/components/timeline/TimelineCanvas.tsx`
- `src/components/timeline/TrackHeader.tsx`
- `src/views/timeline/main.tsx`
- `src/views/mixer/main.tsx`
- `src/components/mixer/MixerStrip.tsx`
- `src/views/pianoRoll/main.tsx`
- `src/components/pianoRoll/PianoRollGrid.tsx`
- `src/components/pianoRoll/VelocityLane.tsx`
- `src/views/browser/main.tsx`
- `src/components/browser/BrowserTree.tsx`
- `src/views/graph/main.tsx`
- `src/components/graph/GraphView.tsx`
- `src/components/shared/Toolbar.tsx`
- `src/components/transport/TimeDisplay.tsx`
- `src/views/index.tsx`
- `src/views/shared/types.ts`
- `src/views/shared/useViewState.ts`

### Not modified

- `src/extension/*`, `src/engine/*`, `src/shared/*` were not touched.
- `src/views/shared/global.css` and `tailwind.config.js` were reviewed and left unchanged (they already cover the required theme variables).

## Build & Test Status

- `bun run build` – **PASS** (includes `tsc --noEmit` and all view bundles)
- `bun run test` – **PASS** (7 suites, 72 tests)
- `bun run typecheck` – **PASS** for UI scope
- Lint: only pre-existing warnings remain in the changed files; no new errors introduced.

## Remaining Notes

- The extension-side handler for `transport/seek` should be added in `src/extension/*` if seeking via the Timeline is intended to move the playhead. The UI now sends the message correctly.
- `src/extension/*`, `src/engine/*`, and `src/shared/*` already had uncommitted changes in the working tree before this review; they are outside this subagent's scope.
