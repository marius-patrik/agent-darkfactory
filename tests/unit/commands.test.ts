import * as vscode from "vscode";
import { registerCommands } from "../../src/extension/commands.js";
import type { PlaywrightEngineManager } from "../../src/extension/playwrightEngine.js";
import type { PianoRollWebviewProvider } from "../../src/extension/views/index.js";

const mockedVscode = vscode as unknown as {
  window: {
    showQuickPick: jest.MockedFunction<typeof vscode.window.showQuickPick>;
    showSaveDialog: jest.MockedFunction<typeof vscode.window.showSaveDialog>;
    withProgress: jest.MockedFunction<typeof vscode.window.withProgress>;
  };
  workspace: {
    getConfiguration: jest.MockedFunction<typeof vscode.workspace.getConfiguration>;
  };
  commands: {
    registerCommand: jest.MockedFunction<typeof vscode.commands.registerCommand>;
  };
};

describe("commands", () => {
  const handlers = new Map<string, () => Promise<void>>();
  const projectManager = {
    exportProject: jest.fn().mockResolvedValue(undefined),
    getActiveProjectId: jest.fn().mockReturnValue("project-1"),
    outputChannel: {
      appendLine: jest.fn(),
      append: jest.fn(),
      clear: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    },
  } as unknown as import("../../src/extension/projectManager.js").ProjectManager;

  beforeEach(() => {
    handlers.clear();
    mockedVscode.commands.registerCommand.mockImplementation(
      (command: string, handler: () => Promise<void>) => {
        handlers.set(command, handler);
        return { dispose: jest.fn() };
      },
    );
    mockedVscode.window.showQuickPick.mockReset();
    mockedVscode.window.showSaveDialog.mockReset();
    mockedVscode.window.withProgress.mockReset();
    mockedVscode.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    projectManager.exportProject = jest.fn().mockResolvedValue(undefined);
  });

  function setupDeps() {
    return registerCommands({
      context: {} as vscode.ExtensionContext,
      projectManager,
      engineManager: {} as PlaywrightEngineManager,
      mixerProvider: {} as import("../../src/extension/views/index.js").MixerWebviewProvider,
      pianoRollProvider: {} as PianoRollWebviewProvider,
      browserProvider: {} as import("../../src/extension/views/index.js").BrowserWebviewProvider,
      graphProvider: {} as import("../../src/extension/views/index.js").GraphWebviewProvider,
    });
  }

  test("vsdaw.export shows format quick pick and save dialog", async () => {
    setupDeps();
    const handler = handlers.get("vsdaw.export");
    expect(handler).toBeDefined();

    mockedVscode.window.showQuickPick.mockResolvedValue("flac" as unknown as vscode.QuickPickItem);
    mockedVscode.window.showSaveDialog.mockResolvedValue({
      fsPath: "/workspace/exports/song.flac",
      toString: () => "file:///workspace/exports/song.flac",
    } as unknown as vscode.Uri);

    await handler!();

    expect(mockedVscode.window.showQuickPick).toHaveBeenCalledWith(
      ["wav", "flac", "ogg", "mp3"],
      expect.objectContaining({ placeHolder: "Select export format" }),
    );
    expect(mockedVscode.window.showSaveDialog).toHaveBeenCalled();
    expect(projectManager.exportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        format: "flac",
        start: 0,
        end: 0,
        stem: false,
      }),
    );
  });

  test("vsdaw.export returns early when format is cancelled", async () => {
    setupDeps();
    const handler = handlers.get("vsdaw.export")!;

    mockedVscode.window.showQuickPick.mockResolvedValue(undefined);

    await handler();

    expect(mockedVscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(projectManager.exportProject).not.toHaveBeenCalled();
  });

  test("vsdaw.export returns early when save dialog is cancelled", async () => {
    setupDeps();
    const handler = handlers.get("vsdaw.export")!;

    mockedVscode.window.showQuickPick.mockResolvedValue("wav" as unknown as vscode.QuickPickItem);
    mockedVscode.window.showSaveDialog.mockResolvedValue(undefined);

    await handler();

    expect(projectManager.exportProject).not.toHaveBeenCalled();
  });
});
