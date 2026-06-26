# VSDAW Architecture

## View-to-Engine Message Adapter

React views and the OpenDAW engine speak different message dialects:

- Views emit slash-delimited actions such as `transport/play`, `track/setMute`,
  and `timeline/moveRegion`.
- The engine expects dotted `MessageType` values such as `transport.play`,
  `track.setMute`, and `region.move`, often with differently shaped payloads.

`src/extension/viewMessageAdapter.ts` translates view messages into engine
envelopes before `MessageRouter` forwards them. The adapter is a pure function
that takes a `projectId` and a `ViewMessage` and returns a host-to-engine
`MessageEnvelope` (or `undefined` for unsupported messages).

Key responsibilities:

1. **Type translation** — maps view types to `MessageType` enum values.
2. **Payload shaping** — renames/restructures fields (e.g. `muted` becomes
   `value`, linear 0..1 volume becomes decibels).
3. **Unsupported-message handling** — lifecycle events, UI-only actions, and
   state-dependent toggles that cannot be translated without extra context
   return `undefined`. The router then logs the reason and sends `host/error`
   back to the views.

`src/extension/messageRouter.ts` wires the adapter into the inbound view path:
validate the raw view message, call `adaptViewMessage`, validate the resulting
envelope, notify `ProjectManager` via `onViewMessage`, and route to the engine.
Engine `error` messages are also forwarded to views as `host/error` so users see
 failures in the UI.
