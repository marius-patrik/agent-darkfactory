# Spec 11: Audio Recording

## Goal
Record live audio from the selected input device into an audio track.

## Messages
- `track/arm` — arm track for recording.
- `transport/record` — start recording.
- `track/setInputDevice` — choose input.

## UI Behaviors
- Input device selector in track header and settings.
- Arm button turns red when armed.
- Recording during transport produces an audio region aligned to playhead.
