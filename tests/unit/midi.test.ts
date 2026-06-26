import { MidiParseError, parseMidiFile } from "../../src/shared/midi.js";

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

describe("parseMidiFile", () => {
  test("parses a minimal single-note MIDI file", () => {
    const parsed = parseMidiFile(buildMinimalMidi());
    expect(parsed.format).toBe(0);
    expect(parsed.ticksPerQuarter).toBe(96);
    expect(parsed.tempo).toBe(500_000);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toEqual({
      tick: 0,
      duration: 96,
      pitch: 60,
      velocity: 100,
    });
  });

  test("rejects non-MIDI data", () => {
    expect(() => parseMidiFile(new Uint8Array([1, 2, 3]))).toThrow(MidiParseError);
  });

  test("rejects unsupported SMPTE division", () => {
    const data = buildMinimalMidi();
    data[12] = 0xe7;
    data[13] = 0x28;
    expect(() => parseMidiFile(data)).toThrow(MidiParseError);
  });

  test("treats note-on with velocity 0 as note-off", () => {
    const base = buildMinimalMidi();
    const noteOffIndex = base.findIndex((byte, i) => byte === 0x80 && base[i + 1] === 0x3c);
    expect(noteOffIndex).toBeGreaterThan(-1);
    base[noteOffIndex] = 0x90;
    const parsed = parseMidiFile(base);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].duration).toBe(96);
  });
});
