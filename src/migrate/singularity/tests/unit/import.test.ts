import type * as vscode from "vscode";
import type { MessageRouter } from "../../src/extension/messageRouter.js";
import type { PlaywrightEngineManager } from "../../src/extension/playwrightEngine.js";
import { ProjectManager } from "../../src/extension/projectManager.js";
import { MessageType } from "../../src/shared/protocol.js";

const PROJECT_ID = "project-test";
const TRACK_ID = "track-1";
const REGION_ID = "region-1";
const SAMPLE_ID = "sample-1";

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

interface TestSession {
  projectId: string;
  uri: vscode.Uri;
  engineReady: boolean;
  pendingEngineMessages: unknown[];
  views: Map<string, unknown>;
  isDirty: boolean;
  isUntitled: boolean;
  projectJson?: unknown;
  audioFiles: Map<string, Uint8Array>;
  regionAudioFiles: Map<string, string>;
}

function getSession(manager: ProjectManager): TestSession {
  const session = (manager as unknown as { sessions: Map<string, TestSession> }).sessions.get(
    PROJECT_ID,
  );
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
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
    router: router as unknown as MessageRouter,
    engineManager: {} as unknown as PlaywrightEngineManager,
  });

  const sessionUri = { toString: () => "file:///test.vsdaw" } as unknown as vscode.Uri;
  (manager as unknown as { sessions: Map<string, TestSession> }).sessions.set(PROJECT_ID, {
    projectId: PROJECT_ID,
    uri: sessionUri,
    engineReady: true,
    pendingEngineMessages: [],
    views: new Map(),
    isDirty: false,
    isUntitled: false,
    projectJson: undefined,
    audioFiles: new Map(),
    regionAudioFiles: new Map(),
  });
  (manager as unknown as { activeProjectId: string }).activeProjectId = PROJECT_ID;

  return manager;
}

function buildMinimalMidi(): Uint8Array {
  const header = new Uint8Array([
    0x4d,
    0x54,
    0x68,
    0x64, // MThd
    0x00,
    0x00,
    0x00,
    0x06, // header length
    0x00,
    0x00, // format 0
    0x00,
    0x01, // 1 track
    0x00,
    0x60, // 96 ppqn
  ]);

  const trackData = new Uint8Array([
    0x00,
    0xff,
    0x51,
    0x03,
    0x07,
    0xa1,
    0x20, // set tempo 500000us
    0x00,
    0x90,
    0x3c,
    0x64, // note on C4 velocity 100
    0x60,
    0x80,
    0x3c,
    0x00, // note off after 96 ticks
    0x00,
    0xff,
    0x2f,
    0x00, // end of track
  ]);

  const trackHeader = new Uint8Array([
    0x4d,
    0x54,
    0x72,
    0x6b, // MTrk
    (trackData.length >> 24) & 0xff,
    (trackData.length >> 16) & 0xff,
    (trackData.length >> 8) & 0xff,
    trackData.length & 0xff,
  ]);

  const result = new Uint8Array(header.length + trackHeader.length + trackData.length);
  result.set(header, 0);
  result.set(trackHeader, header.length);
  result.set(trackData, header.length + trackHeader.length);
  return result;
}

describe("ProjectManager import", () => {
  let router: ReturnType<typeof createMockRouter>;
  let manager: ProjectManager;

  beforeEach(() => {
    jest.useFakeTimers();
    router = createMockRouter();
    manager = createProjectManager(router);

    router.requestEngine.mockImplementation(async (_projectId, type) => {
      switch (type) {
        case MessageType.AudioImport:
          return {
            projectId: PROJECT_ID,
            direction: "engine-to-host",
            type: `${MessageType.AudioImport}.ack`,
            payload: {
              sampleId: SAMPLE_ID,
              sample: { uuid: SAMPLE_ID, name: "loop.wav", duration: 48000, bpm: 120 },
            },
          };
        case MessageType.TrackCreate:
          return {
            projectId: PROJECT_ID,
            direction: "engine-to-host",
            type: `${MessageType.TrackCreate}.ack`,
            payload: { trackId: TRACK_ID },
          };
        case MessageType.RegionCreateAudio:
          return {
            projectId: PROJECT_ID,
            direction: "engine-to-host",
            type: `${MessageType.RegionCreateAudio}.ack`,
            payload: { regionId: REGION_ID },
          };
        case MessageType.RegionCreateMidi:
          return {
            projectId: PROJECT_ID,
            direction: "engine-to-host",
            type: `${MessageType.RegionCreateMidi}.ack`,
            payload: { regionId: REGION_ID },
          };
        default:
          throw new Error(`Unexpected engine request: ${type}`);
      }
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("importAudio reads file, stores it in bundle audioFiles and creates region", async () => {
    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00]);
    const uri = {
      fsPath: "/samples/loop.wav",
      toString: () => "file:///samples/loop.wav",
    } as unknown as vscode.Uri;

    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(audioBytes);

    await manager.importAudio(uri);

    const session = getSession(manager);
    expect(session.audioFiles.has("audio/loop.wav")).toBe(true);
    expect(session.audioFiles.get("audio/loop.wav")).toEqual(audioBytes);

    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.AudioImport,
      expect.objectContaining({
        data: Buffer.from(audioBytes).toString("base64"),
        name: "loop.wav",
      }),
      expect.anything(),
    );
    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.RegionCreateAudio,
      expect.objectContaining({
        trackId: TRACK_ID,
        audioFileId: "audio/loop.wav",
        name: "loop.wav",
      }),
      expect.anything(),
    );

    expect(session.isDirty).toBe(true);
    expect(session.regionAudioFiles.get(REGION_ID)).toBe("audio/loop.wav");
  });

  test("importAudio uses provided trackId without creating a new track", async () => {
    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const uri = {
      fsPath: "/samples/loop.wav",
      toString: () => "file:///samples/loop.wav",
    } as unknown as vscode.Uri;

    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(audioBytes);

    await manager.importAudio(uri, "existing-track");

    expect(router.requestEngine).not.toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.TrackCreate,
      expect.anything(),
      expect.anything(),
    );
    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.RegionCreateAudio,
      expect.objectContaining({ trackId: "existing-track" }),
      expect.anything(),
    );
  });

  test("importMidi parses file, creates MIDI track and region, and queues notes", async () => {
    const midiBytes = buildMinimalMidi();
    const uri = {
      fsPath: "/samples/lead.mid",
      toString: () => "file:///samples/lead.mid",
    } as unknown as vscode.Uri;

    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(midiBytes);

    await manager.importMidi(uri);

    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.TrackCreate,
      expect.objectContaining({ type: "midi" }),
      expect.anything(),
    );
    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.RegionCreateMidi,
      expect.objectContaining({ trackId: TRACK_ID, duration: 960, name: "lead.mid" }),
      expect.anything(),
    );

    expect(router.routeToEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        type: MessageType.MidiAddNote,
        payload: expect.objectContaining({ regionId: REGION_ID, pitch: 60, velocity: 100 }),
      }),
    );

    const session = getSession(manager);
    expect(session.isDirty).toBe(true);
  });

  test("importMidi uses provided trackId without creating a new track", async () => {
    const midiBytes = buildMinimalMidi();
    const uri = {
      fsPath: "/samples/lead.mid",
      toString: () => "file:///samples/lead.mid",
    } as unknown as vscode.Uri;

    jest.spyOn(require("vscode").workspace.fs, "readFile").mockResolvedValue(midiBytes);

    await manager.importMidi(uri, "existing-midi-track");

    expect(router.requestEngine).not.toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.TrackCreate,
      expect.anything(),
      expect.anything(),
    );
    expect(router.requestEngine).toHaveBeenCalledWith(
      PROJECT_ID,
      MessageType.RegionCreateMidi,
      expect.objectContaining({ trackId: "existing-midi-track" }),
      expect.anything(),
    );
  });

  test("importAudio throws when there is no active project", async () => {
    (manager as unknown as { activeProjectId: string | undefined }).activeProjectId = undefined;
    const uri = { fsPath: "/samples/loop.wav" } as unknown as vscode.Uri;
    await expect(manager.importAudio(uri)).rejects.toThrow("No active VSDAW project");
  });

  test("importMidi throws when there is no active project", async () => {
    (manager as unknown as { activeProjectId: string | undefined }).activeProjectId = undefined;
    const uri = { fsPath: "/samples/lead.mid" } as unknown as vscode.Uri;
    await expect(manager.importMidi(uri)).rejects.toThrow("No active VSDAW project");
  });
});
