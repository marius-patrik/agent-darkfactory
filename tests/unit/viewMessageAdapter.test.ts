import { adaptViewMessage } from "../../src/extension/viewMessageAdapter.js";
import { type MessageEnvelope, MessageType } from "../../src/shared/protocol.js";
import type { NoteState, TimeSignature, ViewMessage } from "../../src/views/shared/types.js";

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

  describe("piano roll messages", () => {
    test("pianoRoll/setNoteVelocity -> midi.setNoteVelocity", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "pianoRoll/setNoteVelocity",
        noteId: "note-1",
        velocity: 100,
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.MidiSetNoteVelocity);
      expect(result.payload).toEqual({ noteId: "note-1", velocity: 100 });
    });

    test("pianoRoll/deleteNote -> midi.deleteNote", () => {
      const result = adaptViewMessage(PROJECT_ID, {
        type: "pianoRoll/deleteNote",
        noteId: "note-1",
      });
      expectEnvelope(result);
      expect(result.type).toBe(MessageType.MidiDeleteNote);
      expect(result.payload).toEqual({ noteId: "note-1" });
    });
  });

  describe("unsupported messages", () => {
    const unsupportedCases: ViewMessage[] = [
      { type: "view/ready", view: "timeline" },
      { type: "transport/toggleLoop" },
      { type: "transport/toggleMetronome" },
      { type: "timeline/selectRegion", regionId: null },
      {
        type: "pianoRoll/addNote",
        note: {
          id: "note-1",
          start: 0,
          duration: 1,
          pitch: 60,
          velocity: 100,
        } as NoteState,
      },
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
