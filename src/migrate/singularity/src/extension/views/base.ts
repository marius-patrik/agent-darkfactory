import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { MessageRouter } from "../messageRouter.js";

export interface ViewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  projectId: string;
  viewType: string;
  bundleName?: string;
  serverOrigin: string;
}

export function setViewHtml(options: ViewHtmlOptions): void {
  const { webview, extensionUri, projectId, viewType, bundleName, serverOrigin } = options;
  const nonce = crypto.randomUUID();
  const cspSource = webview.cspSource;
  const resolvedBundleName = bundleName ?? viewType;
  const bundleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "webview", "views", `${resolvedBundleName}.js`),
  );

  const frameSrc = serverOrigin ? `frame-src ${serverOrigin};` : "";
  const connectSrc = serverOrigin
    ? `connect-src ${serverOrigin} ${cspSource};`
    : `connect-src ${cspSource};`;
  const csp = `default-src 'none'; ${frameSrc} script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline' ${cspSource}; ${connectSrc} img-src data: blob: ${cspSource}; font-src ${cspSource};`;

  webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #cccccc); font-family: var(--vscode-font-family); }
        #root { width: 100%; height: 100%; display: flex; flex-direction: column; }
        #placeholder { margin: auto; text-align: center; opacity: 0.7; }
        #error { margin: auto; text-align: center; color: var(--vscode-errorForeground, #f48771); padding: 20px; }
      </style>
    </head>
    <body>
      <div id="root">
        <div id="placeholder">
          <h2>${viewType}</h2>
          <p>Loading view bundle...</p>
          <p id="status"></p>
        </div>
      </div>
      <script nonce="${nonce}">
        (function () {
          const projectId = ${JSON.stringify(projectId)};
          const viewType = ${JSON.stringify(viewType)};
          const status = document.getElementById('status');

          window.vsdaw = { projectId, viewType };

          window.addEventListener('error', function (event) {
            console.error('[vsdaw] runtime error', event.error);
            if (status) status.textContent = 'Error: ' + ((event.error && event.error.message) || event.message);
          });
        })();
      </script>
      <script nonce="${nonce}" src="${bundleUri.toString()}" onerror="const s=document.getElementById('status'); if(s) s.textContent='Failed to load view bundle'"></script>
    </body>
    </html>
  `;
}

export interface ViewPanelOptions {
  context: vscode.ExtensionContext;
  router: MessageRouter;
  projectId: string;
  viewType: string;
  title: string;
  column: vscode.ViewColumn;
  serverOrigin: string;
  bundleName?: string;
}

export function createViewPanel(options: ViewPanelOptions): vscode.WebviewPanel {
  const { context, router, projectId, viewType, title, column, serverOrigin, bundleName } = options;

  const existing = router.findView(projectId, viewType);
  if (existing) {
    existing.reveal(column);
    return existing;
  }

  const panel = vscode.window.createWebviewPanel(viewType, title, column, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out", "webview")],
  });

  setViewHtml({
    webview: panel.webview,
    extensionUri: context.extensionUri,
    projectId,
    viewType,
    bundleName,
    serverOrigin,
  });

  router.registerView(projectId, panel);
  return panel;
}
