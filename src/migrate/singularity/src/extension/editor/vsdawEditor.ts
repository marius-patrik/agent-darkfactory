import * as vscode from "vscode";
import type { ProjectManager } from "../projectManager.js";
import { setViewHtml } from "../views/base.js";

export class VsdawDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // No additional cleanup required; the project manager owns the session.
  }
}

export class VsdawEditorProvider implements vscode.CustomEditorProvider<VsdawDocument> {
  public static readonly viewType = "vsdaw.editor";

  private _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<VsdawDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(
    private context: vscode.ExtensionContext,
    private projectManager: ProjectManager,
    private getServerOrigin: () => string | undefined,
  ) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): VsdawDocument | Thenable<VsdawDocument> {
    return new VsdawDocument(uri);
  }

  async resolveCustomEditor(
    document: VsdawDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "out", "webview")],
    };

    let session: Awaited<ReturnType<ProjectManager["ensureProjectForDocument"]>>;
    try {
      session = await this.projectManager.ensureProjectForDocument(
        document.uri,
        webviewPanel,
        token,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.projectManager.outputChannel.appendLine(
        `[editor] failed to resolve custom editor for ${document.uri.toString()}: ${message}`,
      );
      if (!(error instanceof vscode.CancellationError)) {
        vscode.window.showErrorMessage(`VSDAW: ${message}`);
      }
      webviewPanel.dispose();
      throw error;
    }

    if (token.isCancellationRequested) {
      webviewPanel.dispose();
      throw new vscode.CancellationError();
    }

    setViewHtml({
      webview: webviewPanel.webview,
      extensionUri: this.context.extensionUri,
      projectId: session.projectId,
      viewType: VsdawEditorProvider.viewType,
      bundleName: "timeline",
      serverOrigin: this.getServerOrigin() ?? "",
    });

    const disposables: vscode.Disposable[] = [];

    disposables.push(
      webviewPanel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
          this.projectManager.setActiveProjectId(session.projectId);
        }
      }),
    );

    disposables.push(
      this.projectManager.onDidChangeProject((changedProjectId) => {
        if (changedProjectId === session.projectId) {
          this._onDidChangeCustomDocument.fire({ document });
        }
      }),
    );

    disposables.push(
      webviewPanel.onDidDispose(() => {
        if (this.projectManager.getActiveProjectId() === session.projectId) {
          this.projectManager.setActiveProjectId(undefined);
        }
        for (const d of disposables) {
          d.dispose();
        }
      }),
    );
  }

  async saveCustomDocument(
    document: VsdawDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) return;
    await this.projectManager.saveProjectByUri(document.uri, cancellation);
  }

  async saveCustomDocumentAs(
    document: VsdawDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) return;
    const session = this.projectManager.getSessionByUri(document.uri);
    if (!session) {
      throw new Error("No project session for document");
    }
    await this.projectManager.saveProjectAs(session.projectId, destination, cancellation);
  }

  async revertCustomDocument(
    _document: VsdawDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    // Revert is not supported in Phase 2; the engine owns runtime state.
  }

  async backupCustomDocument(
    document: VsdawDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const session = this.projectManager.getSessionByUri(document.uri);
    let data: Uint8Array | undefined;

    if (session?.engineReady) {
      try {
        const { MessageType } = await import("../../shared/protocol.js");
        const response = await this.projectManager.router.requestEngine(
          session.projectId,
          MessageType.ProjectSave,
          { format: "arraybuffer" },
          { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
        );
        const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
        if (bytes) {
          data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.projectManager.outputChannel.appendLine(`[backup] engine save failed: ${message}`);
      }
    }

    if (!data) {
      try {
        data = await vscode.workspace.fs.readFile(document.uri);
      } catch {
        data = new Uint8Array();
      }
    }

    await vscode.workspace.fs.writeFile(context.destination, data);

    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // ignore
        }
      },
    };
  }
}
