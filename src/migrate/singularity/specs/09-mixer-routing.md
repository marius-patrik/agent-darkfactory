# Spec 09: Mixer Routing and Sends

## Goal
Tracks can route to Master or buses, and send signal to other tracks with level control.

## Messages
- `track/setOutput` — set output target track id.
- `track/addSend` / `track/removeSend` — configure sends.
- `track/setSendLevel` — send gain.

## UI Behaviors
- Mixer strip shows output dropdown.
- Send section lists active sends with level knobs.
- Drag from send slot to another strip to create send.
