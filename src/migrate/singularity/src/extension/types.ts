import type * as vscode from "vscode";
import type { MessageEnvelope } from "../shared/protocol.js";
import type { ProjectJson } from "../shared/schemas.js";
import type { UndoManager } from "./undoManager.js";

export type { MessageEnvelope };

export interface ProjectSession {
  projectId: string;
  uri: vscode.Uri;
  engineReady: boolean;
  pendingEngineMessages: MessageEnvelope[];
  views: Map<string, vscode.WebviewPanel>;
  autoSaveTimer?: NodeJS.Timeout;
  backupTimer?: NodeJS.Timeout;
  isDirty: boolean;
  isUntitled: boolean;
  isSaving?: boolean;
  isClosing?: boolean;
  projectJson?: ProjectJson;
  lastSnapshot?: unknown;
  engineDisposables?: vscode.Disposable[];
  undoManager?: UndoManager<Uint8Array>;
  audioFiles: Map<string, Uint8Array>;
  /** Maps region id -> audio file id for audio regions. */
  regionAudioFiles: Map<string, string>;
}

export interface PendingRequest {
  resolve: (value: MessageEnvelope) => void;
  reject: (reason?: Error) => void;
  timeout: NodeJS.Timeout;
  responseType?: string;
}
