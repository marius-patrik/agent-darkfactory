import * as vscode from "vscode";
import type { MessageEnvelope } from "../shared/protocol.js";

export interface EngineTransport extends vscode.Disposable {
  postMessage(message: MessageEnvelope): void;
  readonly onDidReceiveMessage: vscode.Event<MessageEnvelope>;
  readonly onDidDispose: vscode.Event<void>;
}

export class WebviewEngineTransport implements EngineTransport {
  private _onDidReceiveMessage = new vscode.EventEmitter<MessageEnvelope>();
  public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

  private _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  private disposables: vscode.Disposable[] = [];

  constructor(private panel: vscode.WebviewPanel) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        if (typeof raw === "object" && raw !== null) {
          this._onDidReceiveMessage.fire(raw as MessageEnvelope);
        }
      }),
    );
    this.disposables.push(
      panel.onDidDispose(() => {
        this._onDidDispose.fire();
        this.dispose();
      }),
    );
  }

  postMessage(message: MessageEnvelope): void {
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this._onDidReceiveMessage.dispose();
    this._onDidDispose.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
