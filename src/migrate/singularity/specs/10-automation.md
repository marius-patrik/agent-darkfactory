# Spec 10: Automation Lanes

## Goal
Users can draw parameter automation envelopes on the Timeline.

## Messages
- `automation/addLane` — add lane for a parameter.
- `automation/removeLane` — remove lane.
- `automation/addPoint` / `movePoint` / `deletePoint` — edit envelope.

## UI Behaviors
- Toggle automation lane per track.
- Parameter picker (volume, pan, device parameters).
- Click grid to add breakpoints; drag to move; right-click to delete.
