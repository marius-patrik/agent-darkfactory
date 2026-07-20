export interface MidiNote {
  tick: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface ParsedMidiFile {
  format: number;
  ticksPerQuarter: number;
  tempo: number; // microseconds per quarter note
  notes: MidiNote[];
}

const DEFAULT_TEMPO = 500_000; // 120 BPM

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint24(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]
  );
}

function readVariableLength(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let i = 0;
  while (i < 4) {
    const byte = data[offset + i];
    value = (value << 7) | (byte & 0x7f);
    i++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, length: i };
}

function textDecoder(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("latin1").decode(bytes);
  }
  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  return result;
}

export class MidiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiParseError";
  }
}

export function parseMidiFile(data: Uint8Array): ParsedMidiFile {
  if (data.length < 14 || textDecoder(data.subarray(0, 4)) !== "MThd") {
    throw new MidiParseError("Not a valid MIDI file");
  }

  const headerLength = readUint32(data, 4);
  if (headerLength !== 6) {
    throw new MidiParseError(`Unsupported MIDI header length: ${headerLength}`);
  }

  const format = readUint16(data, 8);
  const trackCount = readUint16(data, 10);
  const division = readUint16(data, 12);

  if ((division & 0x8000) !== 0) {
    throw new MidiParseError("SMPTE timecode division is not supported");
  }

  const ticksPerQuarter = division;
  let tempo = DEFAULT_TEMPO;
  const notes: MidiNote[] = [];

  let offset = 14;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (offset + 8 > data.length) {
      throw new MidiParseError("Truncated MIDI track header");
    }

    const chunkId = textDecoder(data.subarray(offset, offset + 4));
    if (chunkId !== "MTrk") {
      throw new MidiParseError(`Unexpected MIDI chunk: ${chunkId}`);
    }
    const chunkLength = readUint32(data, offset + 4);
    offset += 8;

    if (offset + chunkLength > data.length) {
      throw new MidiParseError("Truncated MIDI track data");
    }

    const trackEnd = offset + chunkLength;
    let tick = 0;
    let runningStatus = 0;
    const activeNotes = new Map<number, { tick: number; velocity: number }>();

    while (offset < trackEnd) {
      const delta = readVariableLength(data, offset);
      offset += delta.length;
      tick += delta.value;

      if (offset >= trackEnd) {
        throw new MidiParseError("Unexpected end of track while reading event status");
      }

      let status = data[offset];

      if (status === 0xff) {
        offset++;
        const metaType = data[offset++];
        const metaLength = readVariableLength(data, offset);
        offset += metaLength.length;

        if (offset + metaLength.value > trackEnd) {
          throw new MidiParseError("Meta event exceeds track bounds");
        }

        if (metaType === 0x2f) {
          offset += metaLength.value;
          if (offset !== trackEnd) {
            offset = trackEnd;
          }
          runningStatus = 0;
          break;
        }

        if (metaType === 0x51 && metaLength.value === 3) {
          tempo = readUint24(data, offset);
        }

        offset += metaLength.value;
        runningStatus = 0;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVariableLength(data, offset + 1);
        offset += 1 + sysexLength.length + sysexLength.value;
        runningStatus = 0;
        continue;
      }

      if (status < 0x80) {
        if (runningStatus === 0) {
          throw new MidiParseError(`Unexpected data byte without running status: ${status}`);
        }
        status = runningStatus;
      } else {
        runningStatus = status;
        offset++;
      }

      const command = status & 0xf0;
      switch (command) {
        case 0x80: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated note-off event");
          const pitch = data[offset++];
          offset++;
          closeNote(activeNotes, notes, pitch, tick);
          break;
        }
        case 0x90: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated note-on event");
          const pitch = data[offset++];
          const velocity = data[offset++];
          if (velocity === 0) {
            closeNote(activeNotes, notes, pitch, tick);
          } else {
            activeNotes.set(pitch, { tick, velocity });
          }
          break;
        }
        case 0xa0:
        case 0xb0: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated MIDI event");
          offset += 2;
          break;
        }
        case 0xc0:
        case 0xd0: {
          offset += 1;
          break;
        }
        case 0xe0: {
          if (offset + 1 >= trackEnd) throw new MidiParseError("Truncated pitch-bend event");
          offset += 2;
          break;
        }
        default: {
          throw new MidiParseError(`Unsupported MIDI status: ${status.toString(16)}`);
        }
      }
    }

    for (const [pitch, note] of activeNotes) {
      notes.push({ tick: note.tick, duration: tick - note.tick, pitch, velocity: note.velocity });
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);

  return { format, ticksPerQuarter, tempo, notes };
}

function closeNote(
  activeNotes: Map<number, { tick: number; velocity: number }>,
  notes: MidiNote[],
  pitch: number,
  tick: number,
): void {
  const note = activeNotes.get(pitch);
  if (!note) return;
  activeNotes.delete(pitch);
  notes.push({
    tick: note.tick,
    duration: Math.max(0, tick - note.tick),
    pitch,
    velocity: note.velocity,
  });
}
