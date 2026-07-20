import type { HostMessage, ViewMessage } from "./types.js";
import { getVsCodeApi } from "./vscodeApi.js";

const vscode = getVsCodeApi<ViewMessage>();

const listeners = new Set<(message: HostMessage) => void>();

window.addEventListener("message", (event) => {
  // In VS Code webviews, messages from the extension host use the webview
  // itself as the source. We accept all data objects with a `type` field.
  if (event.data && typeof event.data === "object" && "type" in event.data) {
    for (const listener of listeners) {
      listener(event.data as HostMessage);
    }
  }
});

/**
 * Thin typed wrapper around `acquireVsCodeApi().postMessage` and the
 * window `message` event. Views use this to send actions to the host and
 * receive authoritative state updates.
 */
export const messageBus = {
  send(message: ViewMessage) {
    vscode.postMessage(message);
  },

  subscribe(listener: (message: HostMessage) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getState(): unknown {
    return vscode.getState();
  },

  setState(state: unknown) {
    vscode.setState(state);
  },
};
