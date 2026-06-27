import { type HandlerResult, handleMessage } from "../../src/engine/messageHandlers.js";
import type { ProjectController } from "../../src/engine/projectAdapter.js";
import { type Message, MessageType } from "../../src/shared/protocol.js";

interface MockController extends ProjectController {
  calls: Array<{ method: string; args: unknown[] }>;
}

function createMockController(): MockController {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const record =
    <T>(method: string, returnValue?: T) =>
    (...args: unknown[]): T => {
      calls.push({ method, args });
      return returnValue as T;
    };

  return {
    calls,
    newProject: record("newProject"),
    loadProject: record("loadProject"),
    serializeProject: record("serializeProject", new ArrayBuffer(8)),
    closeProject: record("closeProject"),

    play: record("play"),
    pause: record("pause"),
    stop: record("stop"),
    record: record("record"),
    seek: record("seek"),
    setLoop: record("setLoop"),
    setTempo: record("setTempo"),
    setTimeSignature: record("setTimeSignature"),

    createTrack: record("createTrack", "track-new"),
    deleteTrack: record("deleteTrack"),
    reorderTrack: record("reorderTrack"),
    setTrackName: record("setTrackName"),
    setTrackColor: record("setTrackColor"),
    setTrackVolumeDb: record("setTrackVolumeDb"),
    setTrackPan: record("setTrackPan"),
    setTrackMute: record("setTrackMute"),
    setTrackSolo: record("setTrackSolo"),
    setTrackArm: record("setTrackArm"),

    createDevice: record("createDevice", "device-new"),
    deleteDevice: record("deleteDevice"),
    moveDevice: record("moveDevice"),
    setDeviceParameter: record("setDeviceParameter"),
    listDevices: record("listDevices", [
      { id: "Tape", name: "Tape", category: "instrument" },
      { id: "Compressor", name: "Compressor", category: "audio-effect" },
    ]),
    getDeviceParameters: record("getDeviceParameters", [
      { name: "mix", value: 0.5, min: 0, max: 1, type: "number" },
    ]),

    createAudioRegion: record("createAudioRegion", "region-audio-new"),
    createMidiRegion: record("createMidiRegion", "region-midi-new"),
    moveRegion: record("moveRegion"),
    resizeRegion: record("resizeRegion"),
    splitRegion: record("splitRegion", ["region-1", "region-2"]),
    setFadeIn: record("setFadeIn"),
    setFadeOut: record("setFadeOut"),
    deleteRegion: record("deleteRegion"),

    addNote: record("addNote", "note-new"),
    moveNote: record("moveNote"),
    resizeNote: record("resizeNote"),
    deleteNote: record("deleteNote"),
    setNoteVelocity: record("setNoteVelocity"),
    handleMidiInput: record("handleMidiInput"),

    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: record("stopRecording"),
    compTakes: record("compTakes"),

    addAutomationLane: record("addAutomationLane", "lane-new"),
    removeAutomationLane: record("removeAutomationLane"),
    addAutomationPoint: record("addAutomationPoint", "point-new"),
    moveAutomationPoint: record("moveAutomationPoint"),
    deleteAutomationPoint: record("deleteAutomationPoint"),

    setTrackOutput: record("setTrackOutput"),
    addTrackSend: record("addTrackSend", "send-new"),
    removeTrackSend: record("removeTrackSend"),
    setTrackSendAmount: record("setTrackSendAmount"),

    getPeaks: jest.fn().mockResolvedValue({
      sampleId: "sample-1",
      channel: 0,
      peaks: new Float32Array([0, 1]),
      sampleRate: 48000,
      numberOfChannels: 1,
      numberOfFrames: 100,
    }),

    renderExport: jest.fn().mockResolvedValue({
      format: "wav",
      data: "dmlkZW8=",
      fileName: "render.wav",
    }),

    getState: record("getState", {
      projectId: "p1",
      tracks: [],
      regions: [],
      notes: [],
      automationLanes: [],
      automationPoints: [],
      transport: {
        isPlaying: false,
        isRecording: false,
        isLooping: false,
        position: 0,
        bpm: 120,
        timeSignature: [4, 4],
        loopStart: 0,
        loopEnd: 0,
      },
    }),
  } as unknown as MockController;
}

function makeMessage(type: string, payload?: unknown): Message {
  return {
    projectId: "p1",
    direction: "host-to-engine",
    type,
    payload,
  };
}

async function expectOk(
  result: Promise<HandlerResult> | HandlerResult,
): Promise<{ type: "ok"; payload?: unknown }> {
  const resolved = await result;
  expect(resolved.type).toBe("ok");
  return resolved as { type: "ok"; payload?: unknown };
}

describe("messageHandlers - project lifecycle", () => {
  test("ProjectNew creates a new project", async () => {
    const controller = createMockController();
    await expectOk(handleMessage(controller, makeMessage(MessageType.ProjectNew, { bpm: 130 })));
    expect(controller.calls).toContainEqual({ method: "newProject", args: [130, undefined] });
  });

  test("ProjectLoad decodes base64 and loads project", async () => {
    const controller = createMockController();
    const data = Buffer.from([1, 2, 3]).toString("base64");
    await expectOk(handleMessage(controller, makeMessage(MessageType.ProjectLoad, { data })));
    expect(controller.calls[0].method).toBe("loadProject");
    expect(controller.calls[0].args[0]).toBeInstanceOf(ArrayBuffer);
  });

  test("ProjectSave returns base64 by default", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(controller, makeMessage(MessageType.ProjectSave, {})),
    );
    expect(typeof result.payload).toBe("string");
  });

  test("ProjectSave returns ArrayBuffer when requested", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(controller, makeMessage(MessageType.ProjectSave, { format: "arraybuffer" })),
    );
    expect(result.payload).toBeInstanceOf(ArrayBuffer);
  });

  test("ProjectClose closes the project", async () => {
    const controller = createMockController();
    await expectOk(handleMessage(controller, makeMessage(MessageType.ProjectClose)));
    expect(controller.calls).toContainEqual({ method: "closeProject", args: [] });
  });
});

describe("messageHandlers - transport commands", () => {
  test.each([
    [MessageType.TransportPlay, "play"],
    [MessageType.TransportPause, "pause"],
    [MessageType.TransportStop, "stop"],
    [MessageType.TransportRecord, "record"],
  ])("%s calls controller.%s", async (type, method) => {
    const controller = createMockController();
    await expectOk(handleMessage(controller, makeMessage(type)));
    expect(controller.calls).toContainEqual({ method, args: [] });
  });

  test("TransportSeek forwards position and unit", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TransportSeek, { position: 96, unit: "bars" }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "seek", args: [96, "bars"] });
  });

  test("TransportSetLoop forwards enabled/start/end", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TransportSetLoop, { enabled: true, start: 0, end: 100 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setLoop", args: [true, 0, 100] });
  });

  test("TransportSetTempo forwards bpm", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.TransportSetTempo, { bpm: 140 })),
    );
    expect(controller.calls).toContainEqual({ method: "setTempo", args: [140] });
  });

  test("TransportSetTimeSignature forwards numerator and denominator", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TransportSetTimeSignature, { numerator: 3, denominator: 4 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setTimeSignature", args: [3, 4] });
  });
});

describe("messageHandlers - track operations", () => {
  test("TrackCreate returns a new track id", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackCreate, {
          type: "audio",
          name: "Vocals",
          index: 2,
          color: "#ff0000",
        }),
      ),
    );
    expect(result.payload).toEqual({ trackId: "track-new" });
    expect(controller.calls).toContainEqual({
      method: "createTrack",
      args: ["audio", "Vocals", 2, "#ff0000"],
    });
  });

  test("TrackDelete forwards trackId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.TrackDelete, { trackId: "t1" })),
    );
    expect(controller.calls).toContainEqual({ method: "deleteTrack", args: ["t1"] });
  });

  test("TrackReorder forwards trackId and newIndex", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackReorder, { trackId: "t1", newIndex: 3 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "reorderTrack", args: ["t1", 3] });
  });

  test("TrackSetName forwards trackId and name", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetName, { trackId: "t1", name: "Drums" }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setTrackName", args: ["t1", "Drums"] });
  });

  test("TrackSetColor forwards trackId and color", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetColor, { trackId: "t1", color: "#00ff00" }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setTrackColor", args: ["t1", "#00ff00"] });
  });

  test("TrackSetVolumeDb forwards trackId and volume", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetVolumeDb, { trackId: "t1", volumeDb: -6 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setTrackVolumeDb", args: ["t1", -6] });
  });

  test("TrackSetPan forwards trackId and pan", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.TrackSetPan, { trackId: "t1", pan: 0.5 })),
    );
    expect(controller.calls).toContainEqual({ method: "setTrackPan", args: ["t1", 0.5] });
  });

  test("TrackSetMute forwards boolean", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetMute, { trackId: "t1", value: true }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setTrackMute", args: ["t1", true] });
  });

  test("TrackAddInsert returns insert id", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackAddInsert, {
          trackId: "t1",
          deviceName: "Reverb",
          insertIndex: 0,
        }),
      ),
    );
    expect(result.payload).toEqual({ insertId: "device-new" });
  });

  test("TrackRemoveInsert forwards insertId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.TrackRemoveInsert, { insertId: "i1" })),
    );
    expect(controller.calls).toContainEqual({ method: "deleteDevice", args: ["i1"] });
  });

  test("TrackMoveInsert forwards insertId and newIndex", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackMoveInsert, { insertId: "i1", newIndex: 1 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "moveDevice", args: ["i1", 1] });
  });

  test("TrackSetInsertParameter forwards deviceId, parameter, and value", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetInsertParameter, {
          deviceId: "i1",
          parameter: "mix",
          value: 0.5,
        }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "setDeviceParameter",
      args: ["i1", "mix", 0.5],
    });
  });

  test("TrackAddInsert uses slot when provided", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackAddInsert, {
          trackId: "t1",
          deviceName: "Tape",
          slot: "instrument",
          insertIndex: 0,
        }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "createDevice",
      args: ["instrument", "Tape", "t1", 0],
    });
  });

  test("TrackSetOutput forwards trackId and outputTrackId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetOutput, { trackId: "t1", outputTrackId: "bus-1" }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "setTrackOutput",
      args: ["t1", "bus-1"],
    });
  });

  test("TrackAddSend forwards trackId, targetTrackId and amount", async () => {
    const controller = createMockController();
    const result = await handleMessage(
      controller,
      makeMessage(MessageType.TrackAddSend, { trackId: "t1", targetTrackId: "bus-1", amount: 0.5 }),
    );
    expect(result.type).toBe("ok");
    expect((result as Extract<typeof result, { type: "ok" }>).payload).toEqual({ sendId: "send-new" });
    expect(controller.calls).toContainEqual({
      method: "addTrackSend",
      args: ["t1", "bus-1", 0.5],
    });
  });

  test("TrackRemoveSend forwards sendId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.TrackRemoveSend, { sendId: "s1" })),
    );
    expect(controller.calls).toContainEqual({ method: "removeTrackSend", args: ["s1"] });
  });

  test("TrackSetSendAmount forwards sendId and amount", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.TrackSetSendAmount, { sendId: "s1", amount: 0.75 }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "setTrackSendAmount",
      args: ["s1", 0.75],
    });
  });
});

describe("messageHandlers - note editing", () => {
  test("NoteCreate creates a note and returns id", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.NoteCreate, {
          regionId: "region-1",
          position: 2,
          duration: 1,
          pitch: 60,
          velocity: 100,
        }),
      ),
    );
    expect(result.payload).toEqual({ noteId: "note-new" });
    expect(controller.calls).toContainEqual({
      method: "addNote",
      args: ["region-1", 2, 1, 60, 100],
    });
  });

  test("NoteCreate returns error when regionId is missing", async () => {
    const controller = createMockController();
    const result = await handleMessage(
      controller,
      makeMessage(MessageType.NoteCreate, { position: 2, duration: 1, pitch: 60, velocity: 100 }),
    );
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("regionId");
  });

  test("NoteMove forwards noteId, position and pitch", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.NoteMove, { noteId: "note-1", position: 4, pitch: 64 }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "moveNote",
      args: ["note-1", 4, 64],
    });
  });

  test("NoteResize forwards noteId and duration", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.NoteResize, { noteId: "note-1", duration: 2 })),
    );
    expect(controller.calls).toContainEqual({ method: "resizeNote", args: ["note-1", 2] });
  });

  test("NoteDelete forwards noteId", async () => {
    const controller = createMockController();
    await expectOk(handleMessage(controller, makeMessage(MessageType.NoteDelete, { noteId: "note-1" })));
    expect(controller.calls).toContainEqual({ method: "deleteNote", args: ["note-1"] });
  });

  test("NoteSetVelocity forwards noteId and velocity", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.NoteSetVelocity, { noteId: "note-1", velocity: 100 }),
      ),
    );
    expect(controller.calls).toContainEqual({ method: "setNoteVelocity", args: ["note-1", 100] });
  });
});

describe("messageHandlers - device catalog and parameters", () => {
  test("DeviceList returns controller.listDevices", async () => {
    const controller = createMockController();
    const result = await expectOk(handleMessage(controller, makeMessage(MessageType.DeviceList)));
    expect(result.payload).toEqual(controller.listDevices());
  });

  test("DeviceGetParameters forwards deviceId and returns descriptors", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(controller, makeMessage(MessageType.DeviceGetParameters, { deviceId: "d1" })),
    );
    expect(controller.calls).toContainEqual({ method: "getDeviceParameters", args: ["d1"] });
    expect(result.payload).toEqual(controller.getDeviceParameters("d1"));
  });

  test("DeviceGetParameters returns error when deviceId is missing", async () => {
    const controller = createMockController();
    const result = await handleMessage(
      controller,
      makeMessage(MessageType.DeviceGetParameters, {}),
    );
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("deviceId is required");
  });
});

describe("messageHandlers - export", () => {
  test("ExportRender forwards format, start, end, fileName and stems", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.ExportRender, {
          format: "wav",
          start: 0,
          end: 100,
          fileName: "render.wav",
          stems: true,
        }),
      ),
    );
    expect(controller.renderExport).toHaveBeenCalledWith("wav", 0, 100, "render.wav", true);
  });

  test("ExportAudio forwards format, start, end and stems without fileName", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.ExportAudio, {
          format: "flac",
          start: 10,
          end: 200,
          stems: false,
        }),
      ),
    );
    expect(controller.renderExport).toHaveBeenCalledWith("flac", 10, 200, undefined, false);
  });

  test("ExportAudio returns error when format is missing", async () => {
    const controller = createMockController();
    const result = await handleMessage(controller, makeMessage(MessageType.ExportAudio, {}));
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("format is required");
  });
});

describe("messageHandlers - automation", () => {
  test("AutomationAddLane creates a lane and returns id", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.AutomationAddLane, {
          trackId: "t1",
          target: { type: "volume", trackId: "t1" },
        }),
      ),
    );
    expect(result.payload).toEqual({ laneId: "lane-new" });
    expect(controller.calls).toContainEqual({
      method: "addAutomationLane",
      args: ["t1", { type: "volume", trackId: "t1" }],
    });
  });

  test("AutomationAddLane returns error when trackId is missing", async () => {
    const controller = createMockController();
    const result = await handleMessage(
      controller,
      makeMessage(MessageType.AutomationAddLane, { target: { type: "volume", trackId: "t1" } }),
    );
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("trackId");
  });

  test("AutomationRemoveLane forwards laneId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.AutomationRemoveLane, { laneId: "l1" })),
    );
    expect(controller.calls).toContainEqual({ method: "removeAutomationLane", args: ["l1"] });
  });

  test("AutomationAddPoint creates a point and returns id", async () => {
    const controller = createMockController();
    const result = await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.AutomationAddPoint, { laneId: "l1", position: 4, value: 0.75 }),
      ),
    );
    expect(result.payload).toEqual({ pointId: "point-new" });
    expect(controller.calls).toContainEqual({
      method: "addAutomationPoint",
      args: ["l1", 4, 0.75],
    });
  });

  test("AutomationAddPoint returns error when fields are missing", async () => {
    const controller = createMockController();
    const result = await handleMessage(
      controller,
      makeMessage(MessageType.AutomationAddPoint, { laneId: "l1", position: 4 }),
    );
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("value");
  });

  test("AutomationMovePoint forwards pointId, position and value", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(
        controller,
        makeMessage(MessageType.AutomationMovePoint, { pointId: "p1", position: 8, value: 0.25 }),
      ),
    );
    expect(controller.calls).toContainEqual({
      method: "moveAutomationPoint",
      args: ["p1", 8, 0.25],
    });
  });

  test("AutomationDeletePoint forwards pointId", async () => {
    const controller = createMockController();
    await expectOk(
      handleMessage(controller, makeMessage(MessageType.AutomationDeletePoint, { pointId: "p1" })),
    );
    expect(controller.calls).toContainEqual({ method: "deleteAutomationPoint", args: ["p1"] });
  });
});

describe("messageHandlers - engine error handling", () => {
  test("handler catches synchronous controller errors", async () => {
    const controller = createMockController();
    controller.play = () => {
      throw new Error("AudioContext is suspended");
    };
    const result = await handleMessage(controller, makeMessage(MessageType.TransportPlay));
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toBe("AudioContext is suspended");
  });

  test("handler catches non-Error throws", async () => {
    const controller = createMockController();
    controller.stop = () => {
      throw "Fatal";
    };
    const result = await handleMessage(controller, makeMessage(MessageType.TransportStop));
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toBe("Fatal");
  });

  test("handler returns error for unknown message type", async () => {
    const controller = createMockController();
    const result = await handleMessage(controller, makeMessage("unknown.command"));
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("Unknown message type");
  });

  test("StateGet returns controller state", async () => {
    const controller = createMockController();
    const result = await expectOk(handleMessage(controller, makeMessage(MessageType.StateGet)));
    expect(result.payload).toEqual(
      expect.objectContaining({
        projectId: "p1",
        transport: expect.any(Object),
      }),
    );
  });
});
