import { adaptViewMessage } from "../../src/extension/viewMessageAdapter.js";
import { type MessageEnvelope, MessageType } from "../../src/shared/protocol.js";
import type { TimeSignature, ViewMessage } from "../../src/views/shared/types.js";

const PROJECT_ID = "project-test";

function expectEnvelope(result: MessageEnvelope | undefined): asserts result is MessageEnvelope {
  expect(result).toBeDefined();
}

describe("viewMessageAdapter", () => {
  describe("transport messages", () => {
    test("transport/play -> transport.play", () => {
      const result = adaptViewMessage(PROJECT_ID, { type: "transport/play" });
      expectEnvelope(result);
      expect(result.projectId).toBe(PROJECT_ID);
      expect(result.direction).toBe("host-to-engine");
      expect(result.type).toBe(MessageType.TransportPlay);
      expect(result.payload).toBeUndefined();
    });

    test("transport/pause -> transport.pause", () => {
      const result = adaptViewMessage(PROJECT_ID, { type: "transport/pause" });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportPause);
    });

    test("transport/stop -> transport.stop", () => {
      const result = adaptViewMessage(PROJECT_ID, { type: "transport/stop" });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportStop);
    });

    test("transport/record -> transport.record", () => {
      const result = adaptViewMessage(PROJECT_ID, { type: "transport/record" });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportRecord);
    });

    test("transport/setTempo -> transport.setTempo", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "transport/setTempo",
        bpm: 128,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportSetTempo);
      expect(result.payload).toEqual({ bpm: 128 });
    });

    test("transport/setTimeSignature -> transport.setTimeSignature", () => {
      const timeSignature: TimeSignature = { numerator: 3, denominator: 4 };
      const result = adaptViewMessage(PROJECT_ID, {
        type: "transport/setTimeSignature",
        timeSignature,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportSetTimeSignature);
      expect(result.payload).toEqual({ numerator: 3, denominator: 4 });
    });

    test("transport/seek -> transport.seek (beats to PPQN)", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "transport/seek",
        beats: 16,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TransportSeek);
      expect(result.payload).toEqual({ position: 16 * 960, unit: "ppqn" });
    });
  });

  describe("track messages", () => {
    test("track/setMute -> track.setMute", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setMute",
        trackId: "track-1",
        muted: true,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetMute);
      expect(result.payload).toEqual({ trackId: "track-1", value: true });
    });

    test("track/setSolo -> track.setSolo", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setSolo",
        trackId: "track-1",
        soloed: false,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetSolo);
      expect(result.payload).toEqual({ trackId: "track-1", value: false });
    });

    test("track/setArm -> track.setArm", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setArm",
        trackId: "track-1",
        armed: true,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetArm);
      expect(result.payload).toEqual({ trackId: "track-1", value: true });
    });

    test("track/setVolume -> track.setVolumeDb with dB conversion", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setVolume",
        trackId: "track-1",
        volume: 0.5,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetVolumeDb);
      expect(result.payload).toEqual({
        trackId: "track-1",
        volumeDb: expect.closeTo(-6.02, 1),
      });
    });

    test("track/setVolume clamps out-of-range values", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setVolume",
        trackId: "track-1",
        volume: 2,
      });
      expectEnvelope(result);
      expect((result.payload as { volumeDb: number }).volumeDb).toBeCloseTo(0, 1);
    });

    test("track/setVolume maps zero to minimum dB", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setVolume",
        trackId: "track-1",
        volume: 0,
      });
      expectEnvelope(result);
      expect((result.payload as { volumeDb: number }).volumeDb).toBe(-120);
    });

    test("track/setPan -> track.setPan", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setPan",
        trackId: "track-1",
        pan: -0.5,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetPan);
      expect(result.payload).toEqual({ trackId: "track-1", pan: -0.5 });
    });

    test("track/setName -> track.setName", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setName",
        trackId: "track-1",
        name: "Lead",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetName);
      expect(result.payload).toEqual({ trackId: "track-1", name: "Lead" });
    });

    test("track/create -> track.create with defaults", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/create",
        trackType: "midi",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackCreate);
      expect(result.payload).toMatchObject({
        type: "midi",
        name: "MIDI Track",
      });
      expect(typeof (result.payload as { color: string }).color).toBe("string");
    });

    test("track/create -> track.create with custom name/color", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/create",
        trackType: "audio",
        name: "Vocals",
        color: "#ff0000",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackCreate);
      expect(result.payload).toEqual({
        type: "audio",
        name: "Vocals",
        color: "#ff0000",
      });
    });

    test("track/delete -> track.delete", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/delete",
        trackId: "track-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackDelete);
      expect(result.payload).toEqual({ trackId: "track-1" });
    });

    test("track/setColor -> track.setColor", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setColor",
        trackId: "track-1",
        color: "#00ff00",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetColor);
      expect(result.payload).toEqual({ trackId: "track-1", color: "#00ff00" });
    });

    test("track/addInsert -> track.addInsert", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/addInsert",
        trackId: "track-1",
        deviceName: "Reverb",
        insertIndex: 0,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackAddInsert);
      expect(result.payload).toEqual({
        trackId: "track-1",
        deviceName: "Reverb",
        insertIndex: 0,
      });
    });

    test("track/addInsert forwards slot when provided", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/addInsert",
        trackId: "track-1",
        deviceName: "Tape",
        slot: "instrument",
        insertIndex: 0,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackAddInsert);
      expect(result.payload).toEqual({
        trackId: "track-1",
        deviceName: "Tape",
        slot: "instrument",
        insertIndex: 0,
      });
    });

    test("device/setParameter -> device.setParameter", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "device/setParameter",
        deviceId: "device-1",
        parameter: "mix",
        value: 0.75,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.DeviceSetParameter);
      expect(result.payload).toEqual({
        deviceId: "device-1",
        parameter: "mix",
        value: 0.75,
      });
    });
  });

  describe("timeline messages", () => {
    test("timeline/moveRegion -> region.move", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "timeline/moveRegion",
        regionId: "region-1",
        start: 8,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.RegionMove);
      expect(result.payload).toEqual({ regionId: "region-1", position: 8 });
    });
  });

  describe("automation messages", () => {
    test("automation/addLane -> automation.addLane", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "automation/addLane",
        trackId: "track-1",
        target: { type: "volume", trackId: "track-1" },
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.AutomationAddLane);
      expect(result.payload).toEqual({
        trackId: "track-1",
        target: { type: "volume", trackId: "track-1" },
      });
    });

    test("automation/removeLane -> automation.removeLane", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "automation/removeLane",
        laneId: "lane-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.AutomationRemoveLane);
      expect(result.payload).toEqual({ laneId: "lane-1" });
    });

    test("automation/addPoint -> automation.addPoint", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "automation/addPoint",
        laneId: "lane-1",
        position: 4,
        value: 0.75,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.AutomationAddPoint);
      expect(result.payload).toEqual({ laneId: "lane-1", position: 4, value: 0.75 });
    });

    test("automation/movePoint -> automation.movePoint", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "automation/movePoint",
        pointId: "point-1",
        position: 8,
        value: 0.25,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.AutomationMovePoint);
      expect(result.payload).toEqual({ pointId: "point-1", position: 8, value: 0.25 });
    });

    test("automation/deletePoint -> automation.deletePoint", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "automation/deletePoint",
        pointId: "point-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.AutomationDeletePoint);
      expect(result.payload).toEqual({ pointId: "point-1" });
    });
  });

  describe("note editing messages", () => {
    test("note/create -> note.create", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "note/create",
        regionId: "region-1",
        position: 2,
        duration: 1,
        pitch: 60,
        velocity: 100,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.NoteCreate);
      expect(result.payload).toEqual({
        regionId: "region-1",
        position: 2,
        duration: 1,
        pitch: 60,
        velocity: 100,
      });
    });

    test("note/move -> note.move", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "note/move",
        noteId: "note-1",
        position: 4,
        pitch: 64,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.NoteMove);
      expect(result.payload).toEqual({ noteId: "note-1", position: 4, pitch: 64 });
    });

    test("note/resize -> note.resize", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "note/resize",
        noteId: "note-1",
        duration: 2,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.NoteResize);
      expect(result.payload).toEqual({ noteId: "note-1", duration: 2 });
    });

    test("note/delete -> note.delete", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "note/delete",
        noteId: "note-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.NoteDelete);
      expect(result.payload).toEqual({ noteId: "note-1" });
    });

    test("note/setVelocity -> note.setVelocity", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "note/setVelocity",
        noteId: "note-1",
        velocity: 100,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.NoteSetVelocity);
      expect(result.payload).toEqual({ noteId: "note-1", velocity: 100 });
    });
  });

  describe("routing messages", () => {
    test("track/setOutput -> track.setOutput", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setOutput",
        trackId: "track-1",
        outputTrackId: "bus-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetOutput);
      expect(result.payload).toEqual({ trackId: "track-1", outputTrackId: "bus-1" });
    });

    test("track/addSend -> track.addSend", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/addSend",
        trackId: "track-1",
        targetTrackId: "bus-1",
        amount: 0.5,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackAddSend);
      expect(result.payload).toEqual({ trackId: "track-1", targetTrackId: "bus-1", amount: 0.5 });
    });

    test("track/removeSend -> track.removeSend", () => {
      const result = adaptViewMessage(PROJECT_ID, { type: "track/removeSend", sendId: "send-1" });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackRemoveSend);
      expect(result.payload).toEqual({ sendId: "send-1" });
    });

    test("track/setSendAmount -> track.setSendAmount", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "track/setSendAmount",
        sendId: "send-1",
        amount: 0.75,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.TrackSetSendAmount);
      expect(result.payload).toEqual({ sendId: "send-1", amount: 0.75 });
    });
  });

  describe("unsupported messages", () => {
    const unsupportedCases: ViewMessage[] = [
      { type: "view/ready", view: "timeline" },
      { type: "transport/toggleLoop" },
      { type: "transport/toggleMetronome" },
      { type: "timeline/selectRegion", regionId: null },
      { type: "mixer/openDevice", trackId: "track-1", slotIndex: 0 },
      { type: "browser/preview", nodeId: "node-1" },
      { type: "browser/dragStart", nodeId: "node-1" },
      { type: "command/undo" },
      { type: "command/redo" },
      { type: "command/delete" },
      { type: "command/duplicate" },
      { type: "command/export" },
      { type: "command/show", view: "mixer" },
    ];

    test.each(unsupportedCases)("returns undefined for %s", (message) => {
      const result = adaptViewMessage(PROJECT_ID, message);
      expect(result).toBeUndefined();
    });

    test("returns undefined for unknown types", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "custom/unknown",
      } as unknown as ViewMessage);
      expect(result).toBeUndefined();
    });
  });
});
