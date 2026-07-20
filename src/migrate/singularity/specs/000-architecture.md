# 000 — Engine Runtime Architecture

## Runtime choice

VSDAW runs the OpenDAW audio engine inside a hidden Chromium page rather than inside a VS Code webview. This is required because:

- OpenDAW needs `crossOriginIsolated === true` and `SharedArrayBuffer`.
- VS Code webviews cannot set the `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers needed for cross-origin isolation.
- Running the engine in a separate process keeps audio state alive independently of view tabs, which can be moved between editor groups and destroyed.

## Chrome / Playwright runtime

The extension host uses `chrome-launcher` plus `playwright-core` to manage the engine lifecycle:

1. **Chrome detection**: before launching, `Launcher.getInstallations()` is queried. If no Chrome, Edge, or Chromium installation is found, a clear error is thrown and the user is shown a VS Code message with links to install a Chromium-based browser.
2. **Launch & connect**: `chrome-launcher` starts a headless Chrome instance with remote debugging enabled. `playwright-core` connects over CDP (`chromium.connectOverCDP`) and reuses the default browser context.
3. **Per-project page**: each open `.vsdaw` project gets one `Page`. The page loads `http://127.0.0.1:<port>/engine?projectId=<id>` from the local Bun server, which serves the engine bundle with COOP/COEP headers.
4. **Message bridge**: the page exposes `vsdawSend`, which the engine bundle calls to send `engine-to-host` messages. The extension host calls `page.evaluate` to inject `host-to-engine` messages into `window.vsdawReceiveMessage`.

## Resilience

- **Cleanup**: `PlaywrightEngineManager.stop()` closes all project pages and transports, then closes the Playwright context/browser, kills the `chrome-launcher` process, and finally calls `killAll()` as a safety net. `dispose()` guards against double-dispose.
- **Crash recovery**: each page listens for `crash` and `pageerror` events. On `crash`, the manager attempts to recreate the page for that `projectId` up to a small retry limit. If the limit is exceeded, the engine transport is disposed and the project page is removed.
- **Health check**: the `vsdaw.engineHealth` command sends a `ping` to the engine and waits for a `pong`, showing the round-trip time in a VS Code message.
