import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BundleError, createEmptyProject, readBundle, writeBundle } from "../shared/bundle.js";
import { parseMidiFile } from "../shared/midi.js";
import {
  type ExportAudioPayload,
  type ExportAudioResult,
  type ExportFormat,
  MessageType,
  type ProjectLoadPayload,
  type ProjectNewPayload,
  type ProjectState,
  type StateSetPayload,
  type TrackCreatePayload,
  type TrackType,
} from "../shared/protocol.js";
import type { ProjectJson, Region, Track } from "../shared/schemas.js";
import { acquireServer, releaseServer } from "./audioServer.js";
import type { MessageRouter } from "./messageRouter.js";
import type { PlaywrightEngineManager } from "./playwrightEngine.js";
import { ProjectStateProjector } from "./stateProjector.js";
import type { MessageEnvelope, ProjectSession } from "./types.js";
import { UndoManager } from "./undoManager.js";

export interface ProjectManagerOptions {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  router: MessageRouter;
  engineManager: PlaywrightEngineManager;
}

interface RecoveryMetadata {
  originalUri: string;
  recoveredAt: string;
  projectName: string;
}

const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BACKUP_INTERVAL_MS = 60000;

export class ProjectManager implements vscode.Disposable {
  private sessions = new Map<string, ProjectSession>();
  private projectors = new Map<string, ProjectStateProjector>();
  private uriToProjectId = new Map<string, string>();
  private activeProjectId: string | undefined;
  private serverOrigin: string | undefined;
  private _onDidChangeProject = new vscode.EventEmitter<string>();
  public readonly onDidChangeProject = this._onDidChangeProject.event;

  constructor(private options: ProjectManagerOptions) {}

  dispose(): void {
    this._onDidChangeProject.dispose();
  }

  get context(): vscode.ExtensionContext {
    return this.options.context;
  }

  get router(): MessageRouter {
    return this.options.router;
  }

  get outputChannel(): vscode.OutputChannel {
    return this.options.outputChannel;
  }

  getServerOrigin(): string | undefined {
    return this.serverOrigin;
  }

  getActiveProjectId(): string | undefined {
    return this.activeProjectId;
  }

  setActiveProjectId(projectId: string | undefined): void {
    this.activeProjectId = projectId;
  }

  getSession(projectId: string): ProjectSession | undefined {
    return this.sessions.get(projectId);
  }

  getSessionByUri(uri: vscode.Uri): ProjectSession | undefined {
    const projectId = this.uriToProjectId.get(uri.toString());
    return projectId ? this.sessions.get(projectId) : undefined;
  }

  async initialize(): Promise<void> {
    await this.offerRecovery();
  }

  async newProject(): Promise<void> {
    const uri = await createNewProjectUri(this.context);
    if (!uri) return;

    await writeEmptyProject(uri);
    await openProjectFile(uri);
  }

  async openProject(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "VSDAW Project": ["vsdaw"] },
      openLabel: "Open Project",
    });
    if (!uris || uris.length === 0) return;
    await openProjectFile(uris[0]);
  }

  async ensureProjectForDocument(
    uri: vscode.Uri,
    timelinePanel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
  ): Promise<ProjectSession> {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const existing = this.getSessionByUri(uri);
    if (existing) {
      existing.views.set("vsdaw.editor", timelinePanel);
      this.router.registerView(existing.projectId, timelinePanel);
      this.activeProjectId = existing.projectId;
      return existing;
    }

    return this.createSession(uri, timelinePanel, token);
  }

  private async createSession(
    uri: vscode.Uri,
    timelinePanel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
  ): Promise<ProjectSession> {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const port = await acquireServer(this.context);
    if (token?.isCancellationRequested) {
      await releaseServer();
      throw new vscode.CancellationError();
    }
    this.serverOrigin = `http://127.0.0.1:${port}`;

    const projectId = crypto.randomUUID();
    const isUntitled = uri.scheme !== "file";
    const cleanupDisposables: vscode.Disposable[] = [];

    try {
      const origin = this.serverOrigin ?? `http://127.0.0.1:${port}`;
      const engineTransport = await this.options.engineManager.createEngine(projectId, origin);
      const engineDisposable = this.router.registerEngine(projectId, engineTransport);
      cleanupDisposables.push(engineTransport, engineDisposable);

      const session: ProjectSession = {
        projectId,
        uri,
        engineReady: false,
        pendingEngineMessages: [],
        views: new Map(),
        isDirty: false,
        isUntitled,
        engineDisposables: [engineTransport, engineDisposable],
        undoManager: new UndoManager<Uint8Array>({ limit: 100 }),
        audioFiles: new Map(),
        regionAudioFiles: new Map(),
      };

      session.views.set("vsdaw.editor", timelinePanel);
      this.router.registerView(projectId, timelinePanel);

      this.sessions.set(projectId, session);
      this.uriToProjectId.set(uri.toString(), projectId);
      this.activeProjectId = projectId;

      const projector = new ProjectStateProjector({
        projectId,
        router: this.router,
        getProjectName: () => this.getSessionProjectName(session),
        getSaved: () => !session.isDirty,
      });
      this.projectors.set(projectId, projector);

      cleanupDisposables.push(
        engineTransport.onDidDispose(() => {
          if (!this.sessions.has(projectId)) return;
          this.outputChannel.appendLine(
            `[project] engine transport closed for ${projectId}, closing session`,
          );
          this.closeProject(projectId).catch(() => {
            // ignore
          });
        }),
      );

      cleanupDisposables.push(
        timelinePanel.onDidDispose(() => {
          this.closeProject(projectId).catch(() => {
            // ignore
          });
        }),
      );

      if (uri.scheme === "file") {
        try {
          await this.loadProjectIntoSession(session, token);
        } catch (error) {
          if (error instanceof vscode.CancellationError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.outputChannel.appendLine(`[project] failed to load ${uri.fsPath}: ${message}`);
          vscode.window.showWarningMessage(
            `VSDAW could not load existing project data: ${message}`,
          );
        }
      }

      // Cleanup disposables are now owned by the session lifecycle.
      cleanupDisposables.length = 0;
      return session;
    } catch (error) {
      for (const d of cleanupDisposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      this.sessions.delete(projectId);
      this.uriToProjectId.delete(uri.toString());
      if (this.activeProjectId === projectId) {
        this.activeProjectId = undefined;
      }
      await releaseServer();
      if (this.sessions.size === 0) {
        this.serverOrigin = undefined;
      }
      throw error;
    }
  }

  async closeProject(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || session.isClosing) return;
    session.isClosing = true;

    this.projectors.get(projectId)?.dispose();
    this.projectors.delete(projectId);

    this.clearAutoSave(session);
    this.router.unregisterEngine(projectId);
    session.pendingEngineMessages = [];

    if (session.engineDisposables) {
      for (const d of session.engineDisposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      session.engineDisposables = undefined;
    }

    for (const [, panel] of session.views) {
      try {
        panel.dispose();
      } catch {
        // ignore
      }
    }

    this.sessions.delete(projectId);
    this.uriToProjectId.delete(session.uri.toString());
    if (this.activeProjectId === projectId) {
      this.activeProjectId = undefined;
    }

    if (this.sessions.size === 0) {
      await releaseServer();
      this.serverOrigin = undefined;
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.closeProject(id);
    }
  }

  async saveProject(projectId: string, token?: vscode.CancellationToken): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }
    await this.saveSession(session, token);
  }

  async saveProjectByUri(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
    const session = this.getSessionByUri(uri);
    if (!session) {
      throw new Error(`No project session for ${uri.toString()}`);
    }
    await this.saveSession(session, token);
  }

  async saveProjectAs(
    projectId: string,
    destination: vscode.Uri,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;

    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    this.updateSessionUri(session, destination);
    session.isUntitled = false;

    await this.saveSession(session, token);
  }

  async exportProject(options: {
    projectId: string;
    destination: vscode.Uri;
    format: ExportFormat;
    start?: number;
    end?: number;
    stem?: boolean;
  }): Promise<void> {
    const { projectId, destination, format, start, end, stem } = options;
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "VSDAW export",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 10, message: "Rendering audio..." });
        const response = await this.router.requestEngine(
          projectId,
          MessageType.ExportAudio,
          { format, start, end, stems: stem } satisfies ExportAudioPayload,
          { responseType: `${MessageType.ExportAudio}.ack`, timeoutMs: 120000 },
        );

        progress.report({ increment: 50, message: "Encoding..." });
        const result = response.payload as ExportAudioResult | undefined;
        if (!result?.data) {
          throw new Error("Engine returned empty export data");
        }

        let outputFormat: ExportFormat = format;
        let outputBytes = base64ToUint8Array(result.data);
        let message = result.message;

        if (format !== "wav") {
          const transcoded = await tryTranscodeAudio(outputBytes, format);
          if (transcoded) {
            outputBytes = transcoded;
          } else {
            outputFormat = "wav";
            const warning = `${format.toUpperCase()} encoding is not available; exported as WAV instead.`;
            message = message ? `${message} ${warning}` : warning;
          }
        }

        const outputPath = replaceExtension(destination.fsPath, outputFormat);
        const outputUri = vscode.Uri.file(outputPath);

        progress.report({ increment: 30, message: "Writing to disk..." });
        await this.writeProjectBytes(outputUri, outputBytes);

        progress.report({ increment: 10, message: "Done" });
        const info = message
          ? `VSDAW export to ${outputPath} complete. ${message}`
          : `VSDAW export to ${outputPath} complete`;
        this.outputChannel.appendLine(`[export] ${info}`);
        vscode.window.showInformationMessage(info);
      },
    );
  }

  private async saveSession(
    session: ProjectSession,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;

    if (session.isSaving) {
      // A save is already in progress; do not queue overlapping saves.
      return;
    }

    let targetUri = session.uri;
    if (session.isUntitled) {
      const picked = await vscode.window.showSaveDialog({
        defaultUri: targetUri,
        filters: { "VSDAW Project": ["vsdaw"] },
        saveLabel: "Save Project",
      });
      if (!picked) return;
      if (token?.isCancellationRequested) return;
      this.updateSessionUri(session, picked);
      session.isUntitled = false;
      targetUri = picked;
    }

    session.isSaving = true;
    try {
      const response = await this.router.requestEngine(
        session.projectId,
        MessageType.ProjectSave,
        { format: "arraybuffer" },
        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
      );
      if (token?.isCancellationRequested) return;
      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
      if (!bytes) {
        throw new Error("Engine returned empty project data");
      }

      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      const projectJson = await this.buildProjectJsonForSave(session, targetUri);
      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
      await this.writeProjectBytes(targetUri, bundle);
      session.projectJson = projectJson;
      session.isDirty = false;
      this.updateSaveIndicator(session);
      this.projectors.get(session.projectId)?.broadcastProject();
      this.outputChannel.appendLine(`[project] saved ${targetUri.fsPath}`);
    } finally {
      session.isSaving = false;
    }
  }

  markDirty(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.isClosing) return;
    const becameDirty = !session.isDirty;
    session.isDirty = true;
    if (becameDirty) {
      this._onDidChangeProject.fire(projectId);
      this.projectors.get(projectId)?.broadcastProject();
    }
    this.updateSaveIndicator(session);
    this.scheduleAutoSave(session);
  }

  onEngineReady(projectId: string, payload: unknown): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.engineReady = true;
    this.outputChannel.appendLine(
      `[project] engine ready for ${projectId}: ${JSON.stringify(payload)}`,
    );

    for (const queued of session.pendingEngineMessages) {
      this.router.routeToEngine(projectId, queued);
    }
    session.pendingEngineMessages = [];

    this.projectors.get(projectId)?.broadcastProject();
    this.requestEngineStateDump(projectId);
    void this.projectors.get(projectId)?.requestDeviceList();
  }

  onEngineError(projectId: string, payload: unknown): void {
    this.outputChannel.appendLine(
      `[project] engine error for ${projectId}: ${JSON.stringify(payload)}`,
    );
    vscode.window.showErrorMessage(`VSDAW engine error: ${JSON.stringify(payload)}`);
  }

  onViewMessage(projectId: string, message: MessageEnvelope): void {
    if (message.type === "command/undo") {
      void this.undo(projectId);
      return;
    }
    if (message.type === "command/redo") {
      void this.redo(projectId);
      return;
    }
    this.markDirty(projectId);
  }

  async onBeforeViewMessage(projectId: string, message: MessageEnvelope): Promise<boolean> {
    if (!isMutableMessage(message)) {
      return false;
    }

    const session = this.sessions.get(projectId);
    if (!session?.undoManager) {
      return false;
    }

    try {
      // Establish the base snapshot on the first mutable action.
      if (!session.undoManager.current) {
        const base = await this.captureEngineSnapshot(projectId);
        session.undoManager.setBase(base);
      }

      await this.router.requestEngine(projectId, message.type, message.payload, {
        responseType: `${message.type}.ack`,
        timeoutMs: 30000,
      });

      const snapshot = await this.captureEngineSnapshot(projectId);
      session.undoManager.push(snapshot);
      this.markDirty(projectId);
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[project] mutation failed for ${message.type}: ${text}`);
      vscode.window.showErrorMessage(`VSDAW: ${text}`);
      return true;
    }
  }

  async undo(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session?.undoManager?.canUndo) {
      return;
    }

    const snapshot = session.undoManager.undo();
    if (!snapshot) {
      return;
    }

    await this.restoreEngineSnapshot(projectId, snapshot);
    this.markDirty(projectId);
  }

  async redo(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session?.undoManager?.canRedo) {
      return;
    }

    const snapshot = session.undoManager.redo();
    if (!snapshot) {
      return;
    }

    await this.restoreEngineSnapshot(projectId, snapshot);
    this.markDirty(projectId);
  }

  private async captureEngineSnapshot(projectId: string): Promise<Uint8Array> {
    const response = await this.router.requestEngine(
      projectId,
      MessageType.ProjectSave,
      { format: "arraybuffer" } as const,
      { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
    );
    const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
    if (!bytes) {
      throw new Error("Engine returned empty project data");
    }
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  }

  private async restoreEngineSnapshot(projectId: string, snapshot: Uint8Array): Promise<void> {
    const payload: StateSetPayload = {
      data: Buffer.from(snapshot).toString("base64"),
    };
    await this.router.requestEngine(projectId, MessageType.StateSet, payload, {
      responseType: `${MessageType.StateSet}.ack`,
      timeoutMs: 30000,
    });
  }

  onEngineStateUpdate(projectId: string, message: MessageEnvelope): void {
    const projector = this.projectors.get(projectId);
    if (!projector) return;

    if (message.type === MessageType.StateUpdate) {
      projector.handleStateUpdate(message.payload as ProjectState);
    } else if (message.type === MessageType.TransportPositionChanged) {
      const position = (message.payload as { position?: number }).position ?? 0;
      projector.handleTransportPositionChanged(position);
    }
  }

  onViewSelection(projectId: string, regionId: string | null): void {
    this.projectors.get(projectId)?.updateSelection({
      regionId: regionId ?? undefined,
    });
  }

  private async requestEngineStateDump(projectId: string): Promise<void> {
    try {
      const response = await this.router.requestEngine(projectId, MessageType.StateGet, undefined, {
        responseType: `${MessageType.StateGet}.result`,
        timeoutMs: 10000,
      });
      this.projectors.get(projectId)?.handleStateUpdate(response.payload as ProjectState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[project] state dump failed: ${message}`);
    }
  }

  private getSessionProjectName(session: ProjectSession): string {
    if (session.projectJson?.project.name) {
      return session.projectJson.project.name;
    }
    return path.basename(session.uri.fsPath, ".vsdaw") || "Untitled";
  }

  private scheduleAutoSave(session: ProjectSession): void {
    this.clearAutoSaveTimer(session);
    const config = vscode.workspace.getConfiguration("vsdaw");
    if (!config.get<boolean>("autoSave", true)) return;

    const delay = config.get<number>("autoSaveDelay", 500);
    if (!Number.isFinite(delay) || delay < 0) {
      this.outputChannel.appendLine("[autosave] invalid autoSaveDelay; skipping");
      return;
    }

    session.autoSaveTimer = setTimeout(() => {
      this.saveProject(session.projectId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[autosave] failed: ${message}`);
      });
    }, delay);

    this.scheduleBackup(session);
  }

  private scheduleBackup(session: ProjectSession): void {
    if (session.backupTimer) return;
    session.backupTimer = setInterval(() => {
      this.writeRecoveryBackup(session).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[backup] failed: ${message}`);
      });
    }, BACKUP_INTERVAL_MS);
  }

  private clearAutoSave(session: ProjectSession): void {
    this.clearAutoSaveTimer(session);
    if (session.backupTimer) {
      clearInterval(session.backupTimer);
      session.backupTimer = undefined;
    }
  }

  private clearAutoSaveTimer(session: ProjectSession): void {
    if (session.autoSaveTimer) {
      clearTimeout(session.autoSaveTimer);
      session.autoSaveTimer = undefined;
    }
  }

  private async writeProjectBytes(uri: vscode.Uri, data: Uint8Array): Promise<void> {
    if (uri.scheme === "file") {
      const tempPath = `${uri.fsPath}.tmp-${Date.now()}`;
      const tempUri = vscode.Uri.file(tempPath);
      try {
        await vscode.workspace.fs.writeFile(tempUri, data);
        await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
      } catch (error) {
        // Best-effort cleanup of the temporary file.
        try {
          await vscode.workspace.fs.delete(tempUri);
        } catch {
          // ignore
        }
        throw error;
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, data);
    }
  }

  private async loadProjectIntoSession(
    session: ProjectSession,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;
    const data = await vscode.workspace.fs.readFile(session.uri);
    if (token?.isCancellationRequested) return;

    let bundle: Awaited<ReturnType<typeof readBundle>>;
    try {
      bundle = await readBundle(new Uint8Array(data));
    } catch (error) {
      if (error instanceof BundleError) {
        throw error;
      }
      throw new BundleError(
        `Failed to read bundle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    session.projectJson = bundle.project;

    if (bundle.engineBin && bundle.engineBin.byteLength > 0) {
      const payload: ProjectLoadPayload = {
        data: Buffer.from(bundle.engineBin).toString("base64"),
      };
      const loadMessage: MessageEnvelope = {
        projectId: session.projectId,
        direction: "host-to-engine",
        type: MessageType.ProjectLoad,
        payload,
      };
      this.queueEngineMessage(session, loadMessage);
    } else {
      // Empty/new project bundle: ask the engine to create a matching empty project.
      const payload: ProjectNewPayload = {
        bpm: bundle.project.project.tempo,
        timeSignature: bundle.project.project.timeSignature,
      };
      const newMessage: MessageEnvelope = {
        projectId: session.projectId,
        direction: "host-to-engine",
        type: MessageType.ProjectNew,
        payload,
      };
      this.queueEngineMessage(session, newMessage);
    }
  }

  private queueEngineMessage(session: ProjectSession, message: MessageEnvelope): void {
    if (session.engineReady) {
      this.router.routeToEngine(session.projectId, message);
    } else {
      session.pendingEngineMessages.push(message);
    }
  }

  private async writeRecoveryBackup(session: ProjectSession): Promise<void> {
    if (session.isSaving) {
      // Avoid racing with an active save operation.
      return;
    }

    const recoveryDir = this.getRecoveryDir();
    await fs.mkdir(recoveryDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryPath = path.join(recoveryDir, `${session.projectId}-${timestamp}.vsdaw`);

    try {
      const response = await this.router.requestEngine(
        session.projectId,
        MessageType.ProjectSave,
        { format: "arraybuffer" },
        { responseType: `${MessageType.ProjectSave}.ack`, timeoutMs: 30000 },
      );
      const bytes = response.payload as Uint8Array | ArrayBuffer | undefined;
      if (!bytes) return;
      const engineBin = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      const projectJson = await this.buildProjectJsonForSave(session, session.uri);
      const bundle = await writeBundle(projectJson, session.audioFiles, engineBin);
      await fs.writeFile(recoveryPath, bundle);

      const metadata: RecoveryMetadata = {
        originalUri: session.uri.toString(),
        recoveredAt: new Date().toISOString(),
        projectName: projectJson.project.name,
      };
      await fs.writeFile(
        path.join(recoveryDir, `${session.projectId}-${timestamp}.json`),
        JSON.stringify(metadata, null, 2),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[recovery] backup skipped: ${message}`);
    }
  }

  private async offerRecovery(): Promise<void> {
    const recoveryDir = this.getRecoveryDir();
    let files: string[] = [];
    try {
      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
    } catch {
      return;
    }
    if (files.length === 0) return;

    await this.cleanupStaleRecoveryFiles(recoveryDir, files);

    // Re-read after cleanup.
    try {
      files = (await fs.readdir(recoveryDir)).filter((f) => f.endsWith(".vsdaw"));
    } catch {
      return;
    }
    if (files.length === 0) return;

    const items = await Promise.all(
      files.map(async (fileName) => {
        const metaPath = path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json"));
        let metadata: RecoveryMetadata | undefined;
        try {
          const text = await fs.readFile(metaPath, "utf-8");
          metadata = JSON.parse(text) as RecoveryMetadata;
        } catch {
          // ignore missing/invalid metadata
        }
        const label = metadata ? `${metadata.projectName} (${fileName})` : fileName;
        return { fileName, label, metadata };
      }),
    );

    const selected = await vscode.window.showWarningMessage(
      `VSDAW found ${items.length} recovery file(s). Select a project to restore.`,
      { modal: false },
      ...items.map((i) => i.label),
    );

    if (!selected) return;

    const item = items.find((i) => i.label === selected);
    if (!item) return;

    await this.restoreRecoveryFile(recoveryDir, item.fileName, item.metadata);
  }

  private async cleanupStaleRecoveryFiles(recoveryDir: string, fileNames: string[]): Promise<void> {
    const now = Date.now();
    for (const fileName of fileNames) {
      const filePath = path.join(recoveryDir, fileName);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > RECOVERY_MAX_AGE_MS) {
          await fs.unlink(filePath);
          try {
            await fs.unlink(path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json")));
          } catch {
            // ignore missing metadata
          }
        }
      } catch {
        // ignore stat failures
      }
    }
  }

  private async restoreRecoveryFile(
    recoveryDir: string,
    fileName: string,
    metadata: RecoveryMetadata | undefined,
  ): Promise<void> {
    const recoveryPath = path.join(recoveryDir, fileName);
    const defaultUri = metadata?.originalUri
      ? vscode.Uri.parse(metadata.originalUri)
      : vscode.Uri.file(path.join(os.homedir(), fileName));

    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "VSDAW Project": ["vsdaw"] },
      saveLabel: "Restore Project",
    });

    if (!destination) return;

    try {
      await fs.copyFile(recoveryPath, destination.fsPath);
      await fs.unlink(recoveryPath);
      try {
        await fs.unlink(path.join(recoveryDir, fileName.replace(/\.vsdaw$/, ".json")));
      } catch {
        // ignore missing metadata
      }
      this.outputChannel.appendLine(`[recovery] restored ${destination.fsPath}`);
      vscode.window.showInformationMessage(`VSDAW restored project to ${destination.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[recovery] restore failed: ${message}`);
      vscode.window.showErrorMessage(`VSDAW could not restore project: ${message}`);
    }
  }

  private getRecoveryDir(): string {
    const base =
      this.context.storageUri?.fsPath ??
      path.join(this.context.globalStorageUri.fsPath, "workspace");
    return path.join(base, ".vsdaw", ".recovery");
  }

  private updateSaveIndicator(session: ProjectSession): void {
    const timeline = session.views.get("vsdaw.editor");
    if (timeline) {
      timeline.title = session.isDirty
        ? `Timeline (${session.projectId.slice(0, 8)}) •`
        : `Timeline (${session.projectId.slice(0, 8)})`;
    }
  }

  private async buildProjectJsonForSave(
    session: ProjectSession,
    targetUri: vscode.Uri,
  ): Promise<ProjectJson> {
    const base = session.projectJson ?? createEmptyProject("Untitled", 48000);
    const state = await this.getProjectState(session.projectId);

    const tracks: Track[] = state.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      color: t.color ?? defaultTrackColorHex(t.index),
      volumeDb: t.volumeDb,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      arm: t.arm,
      inserts: t.inserts,
    }));

    const regions: Region[] = state.regions.map((r) => ({
      id: r.id,
      trackId: r.trackId,
      audioFile: r.type === "audio" ? session.regionAudioFiles.get(r.id) : undefined,
      start: r.position,
      duration: r.duration,
      offset: r.offset ?? 0,
      fadeIn: { type: "linear", duration: normalizeFadeValue(r.fadeIn) },
      fadeOut: { type: "linear", duration: normalizeFadeValue(r.fadeOut) },
    }));

    return {
      ...base,
      project: {
        ...base.project,
        name: path.basename(targetUri.fsPath, ".vsdaw"),
        tempo: state.transport.bpm,
        timeSignature: state.transport.timeSignature,
      },
      tracks,
      regions,
    };
  }

  async importAudio(uri: vscode.Uri, trackId?: string): Promise<void> {
    const projectId = this.getActiveProjectId();
    if (!projectId) {
      throw new Error("No active VSDAW project");
    }
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    const fileName = path.basename(uri.fsPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const audioFileId = `audio/${safeAudioFileName(fileName)}`;
    session.audioFiles.set(audioFileId, bytes);

    const imported = await this.router.requestEngine(
      projectId,
      MessageType.AudioImport,
      {
        data: Buffer.from(bytes).toString("base64"),
        name: fileName,
      },
      { responseType: `${MessageType.AudioImport}.ack`, timeoutMs: 60000 },
    );
    const sample = (imported.payload as { sampleId: string; sample: unknown }).sample;

    const targetTrackId = trackId ?? (await this.createTrack(projectId, "audio"));

    const regionResponse = await this.router.requestEngine(
      projectId,
      MessageType.RegionCreateAudio,
      {
        trackId: targetTrackId,
        audioFileId,
        sample,
        position: 0,
        name: fileName,
      },
      { responseType: `${MessageType.RegionCreateAudio}.ack`, timeoutMs: 30000 },
    );
    const regionId = (regionResponse.payload as { regionId: string }).regionId;
    if (regionId) {
      session.regionAudioFiles.set(regionId, audioFileId);
    }

    this.markDirty(projectId);
  }

  async importMidi(uri: vscode.Uri, trackId?: string): Promise<void> {
    const projectId = this.getActiveProjectId();
    if (!projectId) {
      throw new Error("No active VSDAW project");
    }
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    const fileName = path.basename(uri.fsPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = parseMidiFile(bytes);

    const targetTrackId = trackId ?? (await this.createTrack(projectId, "midi"));

    const ticksPerQuarter = parsed.ticksPerQuarter || 960;
    const ppqn = 960;
    const regionDuration =
      parsed.notes.length > 0
        ? Math.max(
            ...parsed.notes.map((n) =>
              Math.round((n.tick + n.duration) * (ppqn / ticksPerQuarter)),
            ),
          )
        : ppqn * 4;

    const regionResponse = await this.router.requestEngine(
      projectId,
      MessageType.RegionCreateMidi,
      {
        trackId: targetTrackId,
        position: 0,
        duration: regionDuration,
        name: fileName,
      },
      { responseType: `${MessageType.RegionCreateMidi}.ack`, timeoutMs: 30000 },
    );
    const regionId = (regionResponse.payload as { regionId: string }).regionId;

    for (const note of parsed.notes) {
      const position = Math.round(note.tick * (ppqn / ticksPerQuarter));
      const duration = Math.max(1, Math.round(note.duration * (ppqn / ticksPerQuarter)));
      this.queueEngineMessage(session, {
        projectId,
        direction: "host-to-engine",
        type: MessageType.MidiAddNote,
        payload: {
          regionId,
          position,
          duration,
          pitch: note.pitch,
          velocity: note.velocity,
        },
      });
    }

    this.markDirty(projectId);
  }

  async setTrackMute(projectId: string, trackId: string, value: boolean): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }
    await this.router.requestEngine(
      projectId,
      MessageType.TrackSetMute,
      { trackId, value },
      { responseType: `${MessageType.TrackSetMute}.ack`, timeoutMs: 30000 },
    );
    this.markDirty(projectId);
  }

  async setTrackSolo(projectId: string, trackId: string, value: boolean): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }
    await this.router.requestEngine(
      projectId,
      MessageType.TrackSetSolo,
      { trackId, value },
      { responseType: `${MessageType.TrackSetSolo}.ack`, timeoutMs: 30000 },
    );
    this.markDirty(projectId);
  }

  async createMidiRegion(
    projectId: string,
    options: {
      trackId?: string;
      position?: number;
      duration?: number;
      name?: string;
    } = {},
  ): Promise<string> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }

    const trackId = options.trackId ?? (await this.createTrack(projectId, "midi"));
    const response = await this.router.requestEngine(
      projectId,
      MessageType.RegionCreateMidi,
      {
        trackId,
        position: options.position ?? 0,
        duration: options.duration ?? 960 * 4,
        name: options.name ?? "MIDI Region",
      },
      { responseType: `${MessageType.RegionCreateMidi}.ack`, timeoutMs: 30000 },
    );
    const regionId = (response.payload as { regionId: string }).regionId;
    if (!regionId) {
      throw new Error("MIDI region creation failed");
    }
    this.markDirty(projectId);
    return regionId;
  }

  async getProjectState(projectId: string): Promise<ProjectState> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session for project ${projectId}`);
    }
    const response = await this.router.requestEngine(projectId, MessageType.StateGet, undefined, {
      responseType: `${MessageType.StateGet}.result`,
      timeoutMs: 10000,
    });
    return response.payload as ProjectState;
  }

  async saveActiveProject(): Promise<void> {
    const projectId = this.activeProjectId;
    if (!projectId) {
      throw new Error("No active VSDAW project");
    }
    await this.saveProject(projectId);
  }

  async createTrack(
    projectId: string,
    type: TrackType,
    name?: string,
    index?: number,
    color?: string,
  ): Promise<string> {
    const defaultName = type === "audio" ? "Audio Track" : type === "midi" ? "MIDI Track" : "Bus";
    const response = await this.router.requestEngine(
      projectId,
      MessageType.TrackCreate,
      { type, name: name ?? defaultName, index, color } satisfies TrackCreatePayload,
      { responseType: `${MessageType.TrackCreate}.ack`, timeoutMs: 30000 },
    );
    const trackId = (response.payload as { trackId: string }).trackId;
    if (!trackId) {
      throw new Error(`Track creation failed for ${type}`);
    }
    return trackId;
  }

  updateSessionUri(session: ProjectSession, newUri: vscode.Uri): void {
    this.uriToProjectId.delete(session.uri.toString());
    session.uri = newUri;
    this.uriToProjectId.set(newUri.toString(), session.projectId);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const buffer = Buffer.from(base64, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function replaceExtension(filePath: string, ext: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(path.dirname(filePath), `${base}.${ext}`);
}

interface FfmpegInstance {
  load: () => Promise<unknown>;
  writeFile: (path: string, data: unknown) => Promise<unknown>;
  exec: (args: string[]) => Promise<unknown>;
  readFile: (path: string) => Promise<unknown>;
}

async function tryTranscodeAudio(
  input: Uint8Array,
  outputFormat: ExportFormat,
): Promise<Uint8Array | undefined> {
  if (outputFormat === "wav") {
    return input;
  }
  try {
    const ffmpegModule = await import("@ffmpeg/ffmpeg");
    const utilModule = await import("@ffmpeg/util");
    const FFmpeg = (ffmpegModule as { FFmpeg?: new () => FfmpegInstance }).FFmpeg;
    const fetchFile = (utilModule as { fetchFile?: (file: Blob) => Promise<Uint8Array> }).fetchFile;
    if (!FFmpeg || !fetchFile) {
      return undefined;
    }

    const ffmpeg = new FFmpeg();
    await ffmpeg.load();
    const source = await fetchFile(new Blob([input.slice()]));
    await ffmpeg.writeFile("input.wav", source);

    const outputExt = outputFormat === "mp3" ? "mp3" : outputFormat === "ogg" ? "ogg" : "flac";
    await ffmpeg.exec(["-i", "input.wav", `output.${outputExt}`]);
    const data = await ffmpeg.readFile(`output.${outputExt}`);

    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeAudioFileName(input: string): string {
  const base = path.basename(input).replace(/[^\w\-. ]+/g, "_");
  return base || `audio-${Date.now()}.wav`;
}

export async function createNewProjectUri(
  context: vscode.ExtensionContext,
): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    const defaultDir = context.globalStorageUri?.fsPath ?? os.homedir();
    const result = await vscode.window.showSaveDialog({
      title: "Create VSDAW Project",
      defaultUri: vscode.Uri.file(path.join(defaultDir, "Untitled.vsdaw")),
      filters: { "VSDAW Project": ["vsdaw"] },
    });
    return result;
  }

  let index = 1;
  let candidate = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, "Untitled.vsdaw"));
  while (await fileExists(candidate)) {
    candidate = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, `Untitled-${index}.vsdaw`));
    index++;
  }
  return candidate;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const MUTABLE_MESSAGE_TYPES = new Set<string>([
  MessageType.TransportSetTempo,
  MessageType.TransportSetTimeSignature,
  MessageType.TrackCreate,
  MessageType.TrackDelete,
  MessageType.TrackReorder,
  MessageType.TrackSetName,
  MessageType.TrackSetColor,
  MessageType.TrackSetVolumeDb,
  MessageType.TrackSetPan,
  MessageType.TrackSetMute,
  MessageType.TrackSetSolo,
  MessageType.TrackSetArm,
  MessageType.TrackAddInsert,
  MessageType.TrackRemoveInsert,
  MessageType.TrackMoveInsert,
  MessageType.TrackSetInsertParameter,
  MessageType.RegionCreateAudio,
  MessageType.RegionCreateMidi,
  MessageType.RegionMove,
  MessageType.RegionResize,
  MessageType.RegionSplit,
  MessageType.RegionSetFadeIn,
  MessageType.RegionSetFadeOut,
  MessageType.RegionDelete,
  MessageType.MidiAddNote,
  MessageType.MidiMoveNote,
  MessageType.MidiResizeNote,
  MessageType.MidiDeleteNote,
  MessageType.MidiSetNoteVelocity,
  MessageType.DeviceCreate,
  MessageType.DeviceDelete,
  MessageType.DeviceMove,
  MessageType.DeviceSetParameter,
]);

function isMutableMessage(message: MessageEnvelope): boolean {
  return MUTABLE_MESSAGE_TYPES.has(message.type);
}

function defaultTrackColorHex(index: number): string {
  const colors = [
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#ef4444",
    "#06b6d4",
    "#f97316",
    "#84cc16",
  ];
  return colors[index % colors.length];
}

function normalizeFadeValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return 0;
}

export async function writeEmptyProject(uri: vscode.Uri): Promise<void> {
  const config = vscode.workspace.getConfiguration("vsdaw");
  const sampleRate = config.get<number>("audio.defaultSampleRate", 48000);
  const project = createEmptyProject(path.basename(uri.fsPath, ".vsdaw"), sampleRate);
  const bytes = await writeBundle(project);
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export async function openProjectFile(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", uri, "vsdaw.editor");
}
