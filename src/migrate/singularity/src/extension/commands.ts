import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TrackType } from "../shared/protocol.js";
import type { PlaywrightEngineManager } from "./playwrightEngine.js";
import type { ProjectManager } from "./projectManager.js";
import type {
  BrowserWebviewProvider,
  GraphWebviewProvider,
  MixerWebviewProvider,
  PianoRollWebviewProvider,
} from "./views/index.js";

export interface CommandDependencies {
  context: vscode.ExtensionContext;
  projectManager: ProjectManager;
  engineManager: PlaywrightEngineManager;
  mixerProvider: MixerWebviewProvider;
  pianoRollProvider: PianoRollWebviewProvider;
  browserProvider: BrowserWebviewProvider;
  graphProvider: GraphWebviewProvider;
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { projectManager } = deps;
  const outputChannel = projectManager.outputChannel;
  const disposables: vscode.Disposable[] = [];

  const register = <T = unknown>(
    command: string,
    handler: (arg?: T) => Promise<unknown> | unknown,
  ) => {
    disposables.push(
      vscode.commands.registerCommand(command, async (arg?: T) => {
        try {
          return await handler(arg);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outputChannel.appendLine(`[command:${command}] error: ${message}`);
          if (!(error instanceof vscode.CancellationError)) {
            vscode.window.showErrorMessage(`VSDAW: ${message}`);
          }
        }
      }),
    );
  };

  register("vsdaw.newProject", () => projectManager.newProject());
  register("vsdaw.openProject", () => projectManager.openProject());

  register<{ type: TrackType; name?: string; index?: number; color?: string }>(
    "vsdaw.createTrack",
    async (args) => {
      const projectId = getActiveProjectId(projectManager);
      if (!projectId) return;
      const type =
        args?.type ??
        (await vscode.window.showQuickPick(["audio", "midi", "bus"], {
          placeHolder: "Select track type",
        }));
      if (!type) return;
      const name = args?.name ?? (await vscode.window.showInputBox({ prompt: "Track name" }));
      return projectManager.createTrack(projectId, type as TrackType, name ?? undefined);
    },
  );

  register<{ trackId: string; value: boolean }>("vsdaw.setTrackMute", async (args) => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId || args?.trackId == null || args?.value == null) return;
    return projectManager.setTrackMute(projectId, args.trackId, args.value);
  });

  register<{ trackId: string; value: boolean }>("vsdaw.setTrackSolo", async (args) => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId || args?.trackId == null || args?.value == null) return;
    return projectManager.setTrackSolo(projectId, args.trackId, args.value);
  });

  register<{ trackId?: string; position?: number; duration?: number; name?: string }>(
    "vsdaw.createMidiRegion",
    async (args) => {
      const projectId = getActiveProjectId(projectManager);
      if (!projectId) return;
      return projectManager.createMidiRegion(projectId, args);
    },
  );

  register("vsdaw.saveProject", () => projectManager.saveActiveProject());

  register("vsdaw.getProjectState", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return undefined;
    return projectManager.getProjectState(projectId);
  });

  register("vsdaw.undo", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    return projectManager.undo(projectId);
  });

  register("vsdaw.redo", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    return projectManager.redo(projectId);
  });

  register("vsdaw.showTimeline", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    const session = projectManager.getSession(projectId);
    if (!session) return;
    const timeline = session.views.get("vsdaw.editor");
    if (timeline) {
      timeline.reveal(vscode.ViewColumn.One);
    } else {
      await vscode.commands.executeCommand("vscode.openWith", session.uri, "vsdaw.editor", {
        preview: false,
      });
    }
  });

  register("vsdaw.showMixer", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.mixerProvider.show(projectId);
  });

  register("vsdaw.showPianoRoll", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.pianoRollProvider.show(projectId);
  });

  register("vsdaw.showBrowser", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.browserProvider.show(projectId);
  });

  register("vsdaw.showGraph", () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;
    deps.graphProvider.show(projectId);
  });

  register("vsdaw.importAudio", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        "Audio Files": ["wav", "aiff", "flac", "mp3", "ogg", "m4a"],
        "All Files": ["*"],
      },
      openLabel: "Import Audio",
    });
    if (!uris || uris.length === 0) return;

    await projectManager.importAudio(uris[0]);
  });

  register("vsdaw.importMidi", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        "MIDI Files": ["mid", "midi"],
        "All Files": ["*"],
      },
      openLabel: "Import MIDI",
    });
    if (!uris || uris.length === 0) return;

    await projectManager.importMidi(uris[0]);
  });

  register("vsdaw.export", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const format = await vscode.window.showQuickPick(["wav", "flac", "ogg", "mp3"], {
      placeHolder: "Select export format",
    });
    if (!format) return;

    const config = vscode.workspace.getConfiguration("vsdaw");
    const defaultDir = config.get<string>("export.defaultDirectory", "${workspaceFolder}/exports");
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let dir = defaultDir;
    if (workspacePath) {
      dir = dir.replace("${workspaceFolder}", workspacePath);
    } else if (dir.includes("${workspaceFolder}")) {
      dir = path.join(os.homedir(), "exports");
    }
    if (!path.isAbsolute(dir)) {
      dir = path.join(workspacePath ?? os.homedir(), dir);
    }

    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, `export.${format}`)),
      filters: { [format.toUpperCase()]: [format] },
      saveLabel: "Export",
    });
    if (!destination) return;

    await projectManager.exportProject({
      projectId,
      destination,
      format: format as "wav" | "flac" | "ogg" | "mp3",
      start: 0,
      end: 0,
      stem: false,
    });
  });

  register("vsdaw.settings", () => {
    void vscode.commands.executeCommand("workbench.action.openSettings", "vsdaw");
  });

  register("vsdaw.engineHealth", async () => {
    const projectId = getActiveProjectId(projectManager);
    if (!projectId) return;

    const origin = projectManager.getServerOrigin();
    if (!origin) {
      throw new Error("Engine server is not running");
    }

    const result = await deps.engineManager.healthCheck(projectId, origin);
    vscode.window.showInformationMessage(`VSDAW engine is healthy (${result.elapsedMs}ms).`);
  });

  register("vsdaw.showEngineMenu", async () => {
    const { engineManager } = deps;
    const running = engineManager.isRunning;
    const items: vscode.QuickPickItem[] = [
      {
        label: running ? "$(debug-stop) Stop Engine" : "$(play) Start Engine",
        description: running
          ? "Stop the background Chrome audio engine"
          : "Launch background Chrome audio engine",
      },
      {
        label: "$(debug-restart) Restart Engine",
        description: "Restart the background Chrome audio engine",
      },
      {
        label: "$(pulse) Engine Health",
        description: "Ping the audio engine and show response time",
      },
      { label: "$(output) Show Output", description: "Open the VSDAW output channel" },
      { label: "$(gear) Open Settings", description: "Open VSDAW settings" },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `VSDAW Engine — ${running ? "running" : "stopped"}`,
    });
    if (!picked) return;

    if (picked.label.includes("Stop Engine")) {
      await engineManager.stop();
    } else if (picked.label.includes("Start Engine")) {
      await engineManager.start();
    } else if (picked.label.includes("Restart Engine")) {
      await engineManager.stop();
      await engineManager.start();
    } else if (picked.label.includes("Engine Health")) {
      await vscode.commands.executeCommand("vsdaw.engineHealth");
    } else if (picked.label.includes("Show Output")) {
      outputChannel.show();
    } else if (picked.label.includes("Open Settings")) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "vsdaw");
    }
  });

  return disposables;
}

function getActiveProjectId(projectManager: ProjectManager): string | undefined {
  const projectId = projectManager.getActiveProjectId();
  if (projectId) return projectId;

  void vscode.window.showInformationMessage(
    "No active VSDAW project. Open or create a project first.",
  );
  return undefined;
}
