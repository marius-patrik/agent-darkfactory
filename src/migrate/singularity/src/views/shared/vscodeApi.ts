import type { WebviewApi } from "./types.js";

declare function acquireVsCodeApi<T = unknown>(): WebviewApi<T>;

let api: WebviewApi | undefined;

/**
 * Lazily acquires the VS Code webview API. Safe to call from any view entry
 * point after the webview script has loaded.
 */
export function getVsCodeApi<T = unknown>(): WebviewApi<T> {
  if (!api) {
    api = acquireVsCodeApi<T>();
  }
  return api as WebviewApi<T>;
}
