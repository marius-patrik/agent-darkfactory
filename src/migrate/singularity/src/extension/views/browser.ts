import * as vscode from "vscode";
import type { MessageRouter } from "../messageRouter.js";
import { createViewPanel } from "./base.js";

export class BrowserWebviewProvider {
  constructor(
    private context: vscode.ExtensionContext,
    private router: MessageRouter,
    private getServerOrigin: () => string | undefined,
  ) {}

  show(projectId: string): vscode.WebviewPanel {
    return createViewPanel({
      context: this.context,
      router: this.router,
      projectId,
      viewType: "vsdaw.browser",
      bundleName: "browser",
      title: `Browser (${projectId.slice(0, 8)})`,
      column: vscode.ViewColumn.One,
      serverOrigin: this.getServerOrigin() ?? "",
    });
  }
}
