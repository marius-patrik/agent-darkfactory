import * as vscode from "vscode";
import { releaseServer } from "./audioServer.js";
import { registerCommands } from "./commands.js";
import { VsdawEditorProvider } from "./editor/vsdawEditor.js";
import { MessageRouter } from "./messageRouter.js";
import { PlaywrightEngineManager } from "./playwrightEngine.js";
import { ProjectManager } from "./projectManager.js";
import {
  BrowserWebviewProvider,
  GraphWebviewProvider,
  MixerWebviewProvider,
  PianoRollWebviewProvider,
} from "./views/index.js";

let projectManager: ProjectManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("VSDAW");
  context.subscriptions.push(outputChannel);

  const router = new MessageRouter(outputChannel, {
    onEngineReady: (projectId, payload) => {
      outputChannel.appendLine(`[engine] ready for ${projectId}: ${JSON.stringify(payload)}`);
      projectManager?.onEngineReady(projectId, payload);
    },
    onEngineError: (projectId, payload) => {
      outputChannel.appendLine(`[engine] error for ${projectId}: ${JSON.stringify(payload)}`);
      projectManager?.onEngineError(projectId, payload);
    },
    onEngineStateUpdate: (projectId, message) => {
      outputChannel.appendLine(`[engine] state update for ${projectId}: ${message.type}`);
      projectManager?.onEngineStateUpdate(projectId, message);
    },
    onViewMessage: (projectId, message) => {
      outputChannel.appendLine(`[view] ${projectId}: ${message.type}`);
      projectManager?.onViewMessage(projectId, message);
    },
    onViewSelection: (projectId, regionId) => {
      outputChannel.appendLine(`[view] ${projectId}: selection=${regionId}`);
      projectManager?.onViewSelection(projectId, regionId);
    },
  });
  context.subscriptions.push(router);

  const engineManager = new PlaywrightEngineManager({ outputChannel });
  context.subscriptions.push(engineManager);

  projectManager = new ProjectManager({
    context,
    outputChannel,
    router,
    engineManager,
  });
  context.subscriptions.push(projectManager);

  statusBarItem = createStatusBarItem(engineManager, outputChannel);
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  const getServerOrigin = () => projectManager?.getServerOrigin();

  const mixerProvider = new MixerWebviewProvider(context, router, getServerOrigin);
  const pianoRollProvider = new PianoRollWebviewProvider(context, router, getServerOrigin);
  const browserProvider = new BrowserWebviewProvider(context, router, getServerOrigin);
  const graphProvider = new GraphWebviewProvider(context, router, getServerOrigin);

  const editorProvider = new VsdawEditorProvider(context, projectManager, getServerOrigin);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VsdawEditorProvider.viewType, editorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    ...registerCommands({
      context,
      projectManager,
      engineManager,
      mixerProvider,
      pianoRollProvider,
      browserProvider,
      graphProvider,
    }),
  );

  await projectManager.initialize();
}

export function deactivate(): Thenable<void> {
  return Promise.all([projectManager?.closeAll() ?? Promise.resolve(), releaseServer()]).then(
    () => undefined,
  );
}

function createStatusBarItem(
  engineManager: PlaywrightEngineManager,
  outputChannel: vscode.OutputChannel,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "vsdaw.showEngineMenu";

  const update = () => {
    const running = engineManager.isRunning;
    const count = engineManager.projectCount;
    item.text = running
      ? `$(play-circle) VSDAW Engine${count > 0 ? ` (${count})` : ""}`
      : "$(circle-slash) VSDAW Engine";
    item.tooltip = running
      ? `VSDAW audio engine is running with ${count} project(s). Click for options.`
      : "VSDAW audio engine is stopped. Click for options.";
  };

  engineManager.onDidChange(update);
  update();

  return item;
}

export function updateStatusBar(): void {
  statusBarItem?.show();
}
