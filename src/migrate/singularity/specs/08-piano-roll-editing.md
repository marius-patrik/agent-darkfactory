# Spec 08: Piano Roll Note Editing

## Goal
The Piano Roll view becomes a real MIDI editor for composing and editing patterns.

## Messages
- `note/create` — create a note on a region.
- `note/move` — change pitch and/or start time.
- `note/resize` — change duration.
- `note/delete` — remove a note.
- `note/setVelocity` — set velocity.

## UI Behaviors
- Click in grid: create note snapped to grid.
- Drag note body: move pitch/time.
- Drag right edge: resize duration.
- Double-click or Delete key: delete.
- Right-click or panel: quantize selected notes.

## Engine
Add handlers in `src/engine/messageHandlers.ts` that mutate the active MIDI region.
