/**
 * Adapts React view messages into engine envelopes.
 *
 * Views use slash-delimited types (e.g. `transport/play`) while the OpenDAW
 * engine expects dotted `MessageType` values (e.g. `transport.play`). This
 * module performs the translation and shapes the payload so the engine can
 * handle the request directly.
 */

import {
  type MessageEnvelope,
  MessageType,
  type MidiNoteIdPayload,
  type MidiNoteVelocityPayload,
  type RegionMovePayload,
  type TrackBooleanPayload,
  type TrackNamePayload,
  type TrackPanPayload,
  type TrackVolumePayload,
  type TransportSeekPayload,
  type TransportTempoPayload,
  type TransportTimeSignaturePayload,
} from "../shared/protocol.js";
import type { ViewMessage } from "../views/shared/types.js";

const MIN_VOLUME_DB = -120;

function linearToDb(volume: number): number {
  const clamped = Math.max(0, Math.min(1, volume));
  if (clamped <= 0) return MIN_VOLUME_DB;
  return 20 * Math.log10(clamped);
}

/**
 * Translates a view message into a host-to-engine envelope.
 *
 * @returns The adapted envelope, or `undefined` when the view message has no
 * engine equivalent or cannot be converted without additional state.
 */
export function adaptViewMessage(
  projectId: string,
  message: ViewMessage,
): MessageEnvelope | undefined {
  const base = { projectId, direction: "host-to-engine" as const };

  switch (message.type) {
    // Transport
    case "transport/play":
      return { ...base, type: MessageType.TransportPlay };
    case "transport/pause":
      return { ...base, type: MessageType.TransportPause };
    case "transport/stop":
      return { ...base, type: MessageType.TransportStop };
    case "transport/record":
      return { ...base, type: MessageType.TransportRecord };
    case "transport/setTempo": {
      const payload: TransportTempoPayload = { bpm: message.bpm };
      return { ...base, type: MessageType.TransportSetTempo, payload };
    }
    case "transport/setTimeSignature": {
      const payload: TransportTimeSignaturePayload = {
        numerator: message.timeSignature.numerator,
        denominator: message.timeSignature.denominator,
      };
      return { ...base, type: MessageType.TransportSetTimeSignature, payload };
    }
    case "transport/seek": {
      // The timeline works in beats; the engine's transport seek uses PPQN
      // ticks when the unit is "ppqn".
      const payload: TransportSeekPayload = {
        position: message.beats * 960,
        unit: "ppqn",
      };
      return { ...base, type: MessageType.TransportSeek, payload };
    }

    // Tracks
    case "track/setMute": {
      const payload: TrackBooleanPayload = {
        trackId: message.trackId,
        value: message.muted,
      };
      return { ...base, type: MessageType.TrackSetMute, payload };
    }
    case "track/setSolo": {
      const payload: TrackBooleanPayload = {
        trackId: message.trackId,
        value: message.soloed,
      };
      return { ...base, type: MessageType.TrackSetSolo, payload };
    }
    case "track/setArm": {
      const payload: TrackBooleanPayload = {
        trackId: message.trackId,
        value: message.armed,
      };
      return { ...base, type: MessageType.TrackSetArm, payload };
    }
    case "track/setVolume": {
      const payload: TrackVolumePayload = {
        trackId: message.trackId,
        volumeDb: linearToDb(message.volume),
      };
      return { ...base, type: MessageType.TrackSetVolumeDb, payload };
    }
    case "track/setPan": {
      const payload: TrackPanPayload = {
        trackId: message.trackId,
        pan: message.pan,
      };
      return { ...base, type: MessageType.TrackSetPan, payload };
    }
    case "track/setName": {
      const payload: TrackNamePayload = {
        trackId: message.trackId,
        name: message.name,
      };
      return { ...base, type: MessageType.TrackSetName, payload };
    }

    // Timeline
    case "timeline/moveRegion": {
      const payload: RegionMovePayload = {
        regionId: message.regionId,
        position: message.start,
      };
      return { ...base, type: MessageType.RegionMove, payload };
    }

    // Piano roll
    case "pianoRoll/setNoteVelocity": {
      const payload: MidiNoteVelocityPayload = {
        noteId: message.noteId,
        velocity: message.velocity,
      };
      return { ...base, type: MessageType.MidiSetNoteVelocity, payload };
    }
    case "pianoRoll/deleteNote": {
      const payload: MidiNoteIdPayload = { noteId: message.noteId };
      return { ...base, type: MessageType.MidiDeleteNote, payload };
    }

    // Unsupported: lifecycle, UI-only, or state-dependent toggles.
    case "view/ready":
    case "transport/toggleLoop":
    case "transport/toggleMetronome":
    case "timeline/selectRegion":
    case "pianoRoll/addNote":
    case "mixer/openDevice":
    case "browser/preview":
    case "browser/dragStart":
    case "command/undo":
    case "command/redo":
    case "command/delete":
    case "command/duplicate":
    case "command/export":
    case "command/show":
      return undefined;

    default:
      return undefined;
  }
}
