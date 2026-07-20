# 01 — Architecture

## Goal

Run the OpenDAW SDK inside VS Code Desktop with full `SharedArrayBuffer` support, while exposing DAW components as movable IDE tabs.

## Constraints

- OpenDAW requires `crossOriginIsolated === true` to use `SharedArrayBuffer`.
- VS Code webviews cannot directly set `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers.
- Only one `AudioContext` per OpenDAW `Project` should exist; multiple contexts per project waste resources and can conflict.
- VS Code tabs can be moved between editor groups, so a single webview cannot span them.

## High-level design

```
VS Code Desktop
├── Extension Host (Node.js / Bun)
│   ├── projectManager.ts       # open/close/save .vsdaw projects
│   ├── server.ts               # Bun.serve local audio server
│   ├── messageRouter.ts        # route messages between engine and views
│   └── commands.ts             # command palette + keybindings
├── View Tabs (React webviews)
│   ├── Timeline
│   ├── Mixer
│   ├── Piano Roll
│   ├── Browser
│   └── Graph (optional)
└── Hidden Engine Webview (one per open project)
    └── iframe (Bun.serve origin with COOP+COEP)
        └── OpenDAW Project + AudioContext + workers/worklets
```

## Local audio server

- Implementation: `Bun.serve` in `src/extension/server.ts`.
- Bound to `127.0.0.1` on a random free port chosen at extension activation.
- Serves static assets (engine iframe HTML, JS bundles, worker/worklet modules).
- Injects headers on all responses:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Cross-Origin-Resource-Policy: cross-origin` for static assets
- Lifecycle: started on first project open, stopped on extension deactivation or when no projects remain open.

## Engine webview

- Created when a `.vsdaw` project is opened.
- Remains hidden; never shown to the user.
- Contains a single `<iframe src="http://localhost:<port>/engine?projectId=<id>">`.
- The iframe loads the engine bundle and boots OpenDAW SDK.
- All audio state lives here.

## View tabs

- Implemented as separate VS Code webview panels / custom editors.
- Pure React views; they do not own audio state.
- Each view connects to the extension host via `acquireVsCodeApi()` `postMessage`.
- The host routes messages to/from the correct engine webview based on `projectId`.

## Message protocol

All messages are JSON objects with the following envelope:

```ts
interface Message {
  projectId: string;
  direction: 'host-to-engine' | 'engine-to-host' | 'view-to-host' | 'host-to-view';
  type: string;
  payload: unknown;
}
```

### Examples

- `view-to-host`: `{ projectId, type: 'transport.play', payload: {} }`
- `host-to-engine`: forwards the same payload with `direction: 'host-to-engine'`.
- `engine-to-host`: `{ projectId, type: 'state.update', payload: { tracks: [...] } }`
- `host-to-view`: broadcasts state updates to all views for that project.

## Security

- Server binds only to localhost.
- Server refuses requests from non-loopback origins.
- No user credentials or tokens are handled.
- Webview content security policy disallows inline scripts except for the nonce-hashed bootstrap.

## Lifecycle

1. Extension activates.
2. User runs `VSDAW: New Project` or opens a `.vsdaw` file.
3. `projectManager` creates a project session.
4. Server starts if not already running.
5. Hidden engine webview is created and loads the iframe.
6. Engine sends `ready` to host.
7. Host opens Timeline view tab (custom editor).
8. User opens additional view tabs on demand.
9. On project close: engine webview is disposed; if no projects remain, server stops.
10. On extension deactivation: all projects close, server stops.

## Acceptance criteria

1. `window.crossOriginIsolated === true` inside the engine iframe.
2. OpenDAW SDK workers and worklets load from the local server without CORS errors.
3. Multiple view tabs for the same project receive consistent state updates.
4. Server shuts down cleanly on extension deactivation.
