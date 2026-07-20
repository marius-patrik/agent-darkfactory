import * as vscode from "vscode";
import type { MessageRouter } from "../messageRouter.js";
import { createViewPanel } from "./base.js";

export class GraphWebviewProvider {
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
      viewType: "vsdaw.graph",
      bundleName: "graph",
      title: `Graph (${projectId.slice(0, 8)})`,
      column: vscode.ViewColumn.Beside,
      serverOrigin: this.getServerOrigin() ?? "",
    });
  }
}
