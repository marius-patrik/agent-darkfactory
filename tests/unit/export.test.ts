import type * as vscode from "vscode";
import type { PlaywrightEngineManager } from "../../src/extension/playwrightEngine.js";
import { ProjectManager } from "../../src/extension/projectManager.js";
import { MessageType } from "../../src/shared/protocol.js";

const PROJECT_ID = "project-test";
const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // 'RIFF'

function createMockRouter() {
  return {
    requestEngine: jest.fn(),
    routeToEngine: jest.fn(),
    broadcastToViews: jest.fn(),
    routeToViews: jest.fn(),
    registerEngine: jest.fn(() => ({ dispose: jest.fn() })),
    unregisterEngine: jest.fn(),
    registerView: jest.fn(),
    getViews: jest.fn(() => []),
  } as unknown as jest.Mocked<
    Pick<
      import("../../src/extension/messageRouter.js").MessageRouter,
      | "requestEngine"
      | "routeToEngine"
      | "broadcastToViews"
      | "routeToViews"
      | "registerEngine"
      | "unregisterEngine"
      | "registerView"
      | "getViews"
    >
  >;
}

function createProjectManager(router: ReturnType<typeof createMockRouter>): ProjectManager {
  const outputChannel = {
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  } as unknown as vscode.OutputChannel;

  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: "/tmp/vsdaw" },
    storageUri: { fsPath: "/tmp/vsdaw" },
  } as unknown as vscode.ExtensionContext;

  const manager = new ProjectManager({
    context,
    outputChannel,
    router: router as unknown as import("../../src/extension/messageRouter.js").MessageRouter,
    engineManager: {} as unknown as PlaywrightEngineManager,
  });

  const sessionUri = { toString: () => "file:///test.vsdaw" } as unknown as vscode.Uri;
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(PROJECT_ID, {
    projectId: PROJECT_ID,
    uri: sessionUri,
    engineReady: true,
    pendingEngineMessages: [],
    views: new Map(),
    isDirty: false,
    isUntitled: false,
    projectJson: undefined,
    audioFiles: new Map(),
  });

  return manager;
}

describe("ProjectManager export", () => {
  let router: ReturnType<typeof createMockRouter>;
  let manager: ProjectManager;
  let writeFileSpy: jest.SpyInstance;
  let renameSpy: jest.SpyInstance;

  beforeEach(() => {
    router = createMockRouter();
    manager = createProjectManager(router);
    writeFileSpy = jest
      .spyOn(require("vscode").workspace.fs, "writeFile")
      .mockResolvedValue(undefined);
    renameSpy = jest.spyOn(require("vscode").workspace.fs, "rename").mockResolvedValue(undefined);

    router.requestEngine.mockImplementation(async (_projectId, type) => {
      if (type === MessageType.ExportAudio) {
        return {
          projectId: PROJECT_ID,
          direction: "engine-to-host",
          type: `${MessageType.ExportAudio}.ack`,
          payload: {
            format: "wav",
            data: Buffer.from(WAV_BYTES).toString("base64"),
            fileName: "render.wav",
          },
        };
      }
      throw new Error(`Unexpected engine request: ${type}`);
    });
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
  });

  test("exportProject requests ExportAudio and writes WAV data", async () => {
    const destination = {
      fsPath: "/exports/song.wav",
      toString: () => "file:///exports/song.wav",
    } as unknown as vscode.Uri;

    await manager.exportProject({ projectId: PROJECT_ID, destination, format: "wav" });

    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.ExportAudio,
      expect.objectContaining({
        format: "wav",
        start: undefined,
        end: undefined,
        stems: undefined,
      }),
      expect.objectContaining({
        responseType: `${MessageType.ExportAudio}.ack`,
        timeoutMs: 120000,
      }),
    );

    expect(writeFileSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    const finalPath = (renameSpy.mock.calls[0][1].fsPath as string).replace(/\\/g, "/");
    expect(finalPath).toBe("/exports/song.wav");
    const written = writeFileSpy.mock.calls[0][1] as Uint8Array;
    expect(written).toEqual(WAV_BYTES);
  });

  test("exportProject writes decoded WAV bytes for non-wav formats when transcoding unavailable", async () => {
    const destination = {
      fsPath: "/exports/song.flac",
      toString: () => "file:///exports/song.flac",
    } as unknown as vscode.Uri;

    await manager.exportProject({ projectId: PROJECT_ID, destination, format: "flac" });

    expect(writeFileSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    const finalPath = (renameSpy.mock.calls[0][1].fsPath as string).replace(/\\/g, "/");
    expect(finalPath).toBe("/exports/song.wav");
    const written = writeFileSpy.mock.calls[0][1] as Uint8Array;
    expect(written).toEqual(WAV_BYTES);
  });

  test("exportProject throws when there is no session", async () => {
    const destination = { fsPath: "/exports/song.wav" } as unknown as vscode.Uri;
    await expect(
      manager.exportProject({ projectId: "missing-project", destination, format: "wav" }),
    ).rejects.toThrow("No session for project missing-project");
  });

  test("exportProject throws when engine returns empty data", async () => {
    router.requestEngine.mockResolvedValue({
      projectId: PROJECT_ID,
      direction: "engine-to-host",
      type: `${MessageType.ExportAudio}.ack`,
      payload: { format: "wav", data: "", fileName: "render.wav" },
    });

    const destination = { fsPath: "/exports/song.wav" } as unknown as vscode.Uri;
    await expect(
      manager.exportProject({ projectId: PROJECT_ID, destination, format: "wav" }),
    ).rejects.toThrow("Engine returned empty export data");
  });
});
