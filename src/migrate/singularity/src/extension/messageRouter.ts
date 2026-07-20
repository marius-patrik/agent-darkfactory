import * as vscode from "vscode";
import { MessageSchema, MessageType } from "../shared/protocol.js";
import type { HostMessage, ViewMessage } from "../views/shared/types.js";
import type { EngineTransport } from "./engineTransport.js";
import type { MessageEnvelope, PendingRequest } from "./types.js";
import { adaptViewMessage } from "./viewMessageAdapter.js";

export interface MessageRouterCallbacks {
  onEngineReady: (projectId: string, payload: unknown) => void;
  onEngineError: (projectId: string, payload: unknown) => void;
  onEngineStateUpdate: (projectId: string, message: MessageEnvelope) => void;
  onViewMessage: (projectId: string, message: MessageEnvelope) => void;
  onViewSelection?: (projectId: string, regionId: string | null) => void;
  /**
   * Called before an adapted view message is forwarded to the engine. Return
   * `true` to indicate the message has been handled and the default routing
   * should be skipped.
   */
  onBeforeViewMessage?: (projectId: string, message: MessageEnvelope) => Promise<boolean>;
}

export class MessageRouter implements vscode.Disposable {
  private engines = new Map<string, EngineTransport>();
  private views = new Map<string, Set<vscode.WebviewPanel>>();
  private pending = new Map<string, Map<string, PendingRequest>>();

  constructor(
    private outputChannel: vscode.OutputChannel,
    private callbacks: MessageRouterCallbacks,
  ) {}

  dispose(): void {
    for (const [, map] of this.pending) {
      for (const [, req] of map) {
        clearTimeout(req.timeout);
        req.reject(new Error("Message router disposed"));
      }
    }
    this.pending.clear();
    this.engines.clear();
    this.views.clear();
  }

  registerEngine(projectId: string, transport: EngineTransport): vscode.Disposable {
    this.engines.set(projectId, transport);
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      transport.onDidReceiveMessage((message) => {
        this.handleEngineMessage(projectId, message);
      }),
    );

    disposables.push(
      transport.onDidDispose(() => {
        this.unregisterEngine(projectId);
        for (const d of disposables) {
          d.dispose();
        }
      }),
    );

    return {
      dispose: () => {
        for (const d of disposables) {
          d.dispose();
        }
      },
    };
  }

  unregisterEngine(projectId: string): void {
    this.engines.delete(projectId);
    const pending = this.pending.get(projectId);
    if (pending) {
      for (const [, req] of pending) {
        clearTimeout(req.timeout);
        req.reject(new Error("Engine transport disposed"));
      }
      this.pending.delete(projectId);
    }
    // Do NOT delete view registrations here; engine lifecycle is independent of views.
  }

  registerView(projectId: string, panel: vscode.WebviewPanel): void {
    let set = this.views.get(projectId);
    if (!set) {
      set = new Set();
      this.views.set(projectId, set);
    }
    if (set.has(panel)) {
      return;
    }
    set.add(panel);

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handleViewMessage(projectId, raw);
      }),
    );
    disposables.push(
      panel.onDidDispose(() => {
        this.unregisterView(projectId, panel);
        for (const d of disposables) {
          d.dispose();
        }
      }),
    );
  }

  unregisterView(projectId: string, panel: vscode.WebviewPanel): void {
    const set = this.views.get(projectId);
    if (set) {
      set.delete(panel);
      if (set.size === 0) {
        this.views.delete(projectId);
      }
    }
  }

  getViews(projectId: string): vscode.WebviewPanel[] {
    const set = this.views.get(projectId);
    return set ? Array.from(set) : [];
  }

  findView(projectId: string, viewType: string): vscode.WebviewPanel | undefined {
    const set = this.views.get(projectId);
    if (!set) return undefined;
    for (const panel of set) {
      if (panel.viewType === viewType) {
        return panel;
      }
    }
    return undefined;
  }

  routeToEngine(projectId: string, message: Omit<MessageEnvelope, "direction">): void {
    const transport = this.engines.get(projectId);
    if (!transport) {
      this.outputChannel.appendLine(
        `[router] no engine for project ${projectId} (dropping ${message.type})`,
      );
      return;
    }
    const envelope: MessageEnvelope = { ...message, direction: "host-to-engine" };
    try {
      transport.postMessage(envelope);
    } catch (error) {
      this.outputChannel.appendLine(
        `[router] failed to post to engine ${projectId}: ${String(error)}`,
      );
    }
  }

  routeToViews(projectId: string, message: Omit<MessageEnvelope, "direction">): void {
    const envelope: MessageEnvelope = { ...message, direction: "host-to-view" };
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(panel.webview.postMessage(envelope)).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to post to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  broadcastToViews(projectId: string, message: HostMessage): void {
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(panel.webview.postMessage(message)).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to broadcast to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  private routeErrorToViews(projectId: string, text: string): void {
    const set = this.views.get(projectId);
    if (!set) return;
    for (const panel of set) {
      Promise.resolve(
        panel.webview.postMessage({
          type: "host/error",
          message: text,
        }),
      ).catch((error) => {
        this.outputChannel.appendLine(
          `[router] failed to post error to view ${projectId}: ${String(error)}`,
        );
      });
    }
  }

  async requestEngine(
    projectId: string,
    type: string,
    payload: unknown,
    options: { responseType?: string; timeoutMs?: number } = {},
  ): Promise<MessageEnvelope> {
    const transport = this.engines.get(projectId);
    if (!transport) {
      throw new Error(`No engine transport for project ${projectId}`);
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = options.timeoutMs ?? 10000;

    return new Promise<MessageEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.clearPending(projectId, requestId);
        reject(new Error(`Engine request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve,
        reject,
        timeout,
        responseType: options.responseType,
      };

      let map = this.pending.get(projectId);
      if (!map) {
        map = new Map();
        this.pending.set(projectId, map);
      }
      map.set(requestId, pending);

      const envelope: MessageEnvelope = {
        projectId,
        direction: "host-to-engine",
        type,
        payload,
        requestId,
      };
      try {
        transport.postMessage(envelope);
      } catch (error) {
        this.clearPending(projectId, requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private clearPending(projectId: string, requestId: string): void {
    const map = this.pending.get(projectId);
    if (!map) return;
    const req = map.get(requestId);
    if (req) {
      clearTimeout(req.timeout);
      map.delete(requestId);
    }
    if (map.size === 0) {
      this.pending.delete(projectId);
    }
  }

  private handleEngineMessage(projectId: string, raw: unknown): void {
    const parse = MessageSchema.safeParse(raw);
    if (!parse.success) {
      this.outputChannel.appendLine(`[router] invalid engine message: ${JSON.stringify(raw)}`);
      return;
    }
    const message = parse.data as MessageEnvelope;
    if (message.projectId !== projectId) {
      this.outputChannel.appendLine(
        `[router] engine message projectId mismatch: ${message.projectId} vs ${projectId}`,
      );
      return;
    }
    if (message.direction !== "engine-to-host") {
      this.outputChannel.appendLine(
        `[router] unexpected engine message direction: ${message.direction}`,
      );
      return;
    }

    // Resolve pending requests first.
    if (message.requestId) {
      const resolved = this.tryResolvePending(projectId, message);
      if (resolved) return;
      this.outputChannel.appendLine(
        `[router] dropping unmatched engine response: ${message.type} ${message.requestId}`,
      );
      return;
    }

    if (message.type === MessageType.EngineReady) {
      this.callbacks.onEngineReady(projectId, message.payload);
      return;
    }
    if (message.type === MessageType.EngineError) {
      this.callbacks.onEngineError(projectId, message.payload);
      const text =
        typeof message.payload === "object" && message.payload !== null
          ? ((message.payload as { message?: string }).message ?? JSON.stringify(message.payload))
          : String(message.payload);
      this.routeErrorToViews(projectId, text);
      return;
    }

    if (
      message.type === MessageType.StateUpdate ||
      message.type === MessageType.TransportPositionChanged
    ) {
      this.callbacks.onEngineStateUpdate(projectId, message);
      return;
    }

    // Broadcast engine state to all views for this project.
    this.routeToViews(projectId, {
      projectId,
      type: message.type,
      payload: message.payload,
      requestId: message.requestId,
    });
  }

  private tryResolvePending(projectId: string, message: MessageEnvelope): boolean {
    const map = this.pending.get(projectId);
    if (!map || !message.requestId) return false;
    const req = map.get(message.requestId);
    if (!req) return false;

    if (req.responseType && req.responseType !== message.type) {
      this.outputChannel.appendLine(
        `[router] response type mismatch for ${message.requestId}: expected ${req.responseType}, got ${message.type}`,
      );
      return true;
    }

    clearTimeout(req.timeout);
    map.delete(message.requestId);
    if (map.size === 0) {
      this.pending.delete(projectId);
    }
    req.resolve(message);
    return true;
  }

  private async handleViewMessage(projectId: string, raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== "object" || !("type" in raw)) {
      this.outputChannel.appendLine(`[router] invalid view message: ${JSON.stringify(raw)}`);
      return;
    }

    const viewMessage = raw as ViewMessage;

    // Lifecycle/UI-only messages are not forwarded to the engine.
    if (viewMessage.type === "view/ready") {
      return;
    }

    if (viewMessage.type === "timeline/selectRegion") {
      this.callbacks.onViewSelection?.(projectId, viewMessage.regionId ?? null);
      return;
    }

    // Undo/redo are handled by the host project manager, not the engine.
    if (viewMessage.type === "command/undo" || viewMessage.type === "command/redo") {
      this.callbacks.onViewMessage(projectId, {
        projectId,
        direction: "view-to-host",
        type: viewMessage.type,
      });
      return;
    }

    if (viewMessage.type === "device/getParameters") {
      void this.requestEngine(projectId, MessageType.DeviceGetParameters, {
        deviceId: viewMessage.deviceId,
      })
        .then((response) => {
          this.broadcastToViews(projectId, {
            type: "host/deviceParameters",
            deviceId: viewMessage.deviceId,
            parameters: response.payload as {
              name: string;
              value: number | boolean;
              min: number;
              max: number;
              type: "number" | "boolean";
            }[],
          });
        })
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          this.routeErrorToViews(projectId, text);
        });
      return;
    }

    if (viewMessage.type === "command/importAudio") {
      void vscode.commands.executeCommand("vsdaw.importAudio");
      return;
    }

    if (viewMessage.type === "command/importMidi") {
      void vscode.commands.executeCommand("vsdaw.importMidi");
      return;
    }

    const envelope = adaptViewMessage(projectId, viewMessage);
    if (!envelope) {
      const reason = `unsupported view message type: ${viewMessage.type}`;
      this.outputChannel.appendLine(`[router] ${reason}`);
      this.routeErrorToViews(projectId, reason);
      return;
    }

    const parse = MessageSchema.safeParse(envelope);
    if (!parse.success) {
      this.outputChannel.appendLine(`[router] invalid adapted envelope: ${parse.error.message}`);
      return;
    }
    const message = parse.data as MessageEnvelope;
    if (message.projectId !== projectId) {
      this.outputChannel.appendLine(
        `[router] adapted envelope projectId mismatch: ${message.projectId} vs ${projectId}`,
      );
      return;
    }
    if (message.direction !== "host-to-engine") {
      this.outputChannel.appendLine(
        `[router] unexpected adapted envelope direction: ${message.direction}`,
      );
      return;
    }

    const handled = await (this.callbacks.onBeforeViewMessage?.(projectId, message) ??
      Promise.resolve(false));
    if (handled) {
      return;
    }

    this.callbacks.onViewMessage(projectId, message);

    this.routeToEngine(projectId, {
      projectId,
      type: message.type,
      payload: message.payload,
      requestId: message.requestId,
    });
  }
}
