/**
 * Adapts React view messages into engine envelopes.
 *
 * Views use slash-delimited types (e.g. `transport/play`) while the OpenDAW
 * engine expects dotted `MessageType` values (e.g. `transport.play`). This
 * module performs the translation and shapes the payload so the engine can
 * handle the request directly.
 */

import {
  type AutomationAddLanePayload,
  type AutomationAddPointPayload,
  type AutomationDeletePointPayload,
  type AutomationMovePointPayload,
  type AutomationRemoveLanePayload,
  type DeviceIdPayload,
  type DeviceParameterPayload,
  type MessageEnvelope,
  MessageType,
  type NoteCreatePayload,
  type NoteDeletePayload,
  type NoteMovePayload,
  type NoteResizePayload,
  type NoteSetVelocityPayload,
  type RegionMovePayload,
  type TrackBooleanPayload,
  type TrackColorPayload,
  type TrackCreatePayload,
  type TrackIdPayload,
  type TrackInsertPayload,
  type TrackNamePayload,
  type TrackOutputPayload,
  type TrackPanPayload,
  type TrackSendAmountPayload,
  type TrackSendPayload,
  type TrackSendRemovePayload,
  type TrackVolumePayload,
  type TransportSeekPayload,
  type TransportTempoPayload,
  type TransportTimeSignaturePayload,
} from "../shared/protocol.js";
import type { ViewMessage } from "../views/shared/types.js";

const MIN_VOLUME_DB = -120;

const DEFAULT_TRACK_COLORS: Record<"audio" | "midi" | "bus", string> = {
  audio: "hsl(210, 70%, 50%)",
  midi: "hsl(280, 70%, 50%)",
  bus: "hsl(35, 70%, 50%)",
};

function defaultTrackName(type: "audio" | "midi" | "bus"): string {
  switch (type) {
    case "audio":
      return "Audio Track";
    case "midi":
      return "MIDI Track";
    case "bus":
      return "Bus Track";
  }
}

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
    case "track/create": {
      const payload: TrackCreatePayload = {
        type: message.trackType,
        name: message.name ?? defaultTrackName(message.trackType),
        color: message.color ?? DEFAULT_TRACK_COLORS[message.trackType],
      };
      return { ...base, type: MessageType.TrackCreate, payload };
    }
    case "track/delete": {
      const payload: TrackIdPayload = { trackId: message.trackId };
      return { ...base, type: MessageType.TrackDelete, payload };
    }
    case "track/setColor": {
      const payload: TrackColorPayload = {
        trackId: message.trackId,
        color: message.color,
      };
      return { ...base, type: MessageType.TrackSetColor, payload };
    }
    case "track/addInsert": {
      const payload: TrackInsertPayload = {
        trackId: message.trackId,
        deviceName: message.deviceName,
        insertIndex: message.insertIndex,
        slot: message.slot,
      };
      return { ...base, type: MessageType.TrackAddInsert, payload };
    }

    // Devices
    case "device/getParameters": {
      const payload: DeviceIdPayload = { deviceId: message.deviceId };
      return { ...base, type: MessageType.DeviceGetParameters, payload };
    }
    case "device/setParameter": {
      const payload: DeviceParameterPayload = {
        deviceId: message.deviceId,
        parameter: message.parameter,
        value: message.value,
      };
      return { ...base, type: MessageType.DeviceSetParameter, payload };
    }

    // Timeline
    case "timeline/moveRegion": {
      const payload: RegionMovePayload = {
        regionId: message.regionId,
        position: message.start,
      };
      return { ...base, type: MessageType.RegionMove, payload };
    }

    // Automation
    case "automation/addLane": {
      const payload: AutomationAddLanePayload = {
        trackId: message.trackId,
        target: message.target,
      };
      return { ...base, type: MessageType.AutomationAddLane, payload };
    }
    case "automation/removeLane": {
      const payload: AutomationRemoveLanePayload = { laneId: message.laneId };
      return { ...base, type: MessageType.AutomationRemoveLane, payload };
    }
    case "automation/addPoint": {
      const payload: AutomationAddPointPayload = {
        laneId: message.laneId,
        position: message.position,
        value: message.value,
      };
      return { ...base, type: MessageType.AutomationAddPoint, payload };
    }
    case "automation/movePoint": {
      const payload: AutomationMovePointPayload = {
        pointId: message.pointId,
        position: message.position,
        value: message.value,
      };
      return { ...base, type: MessageType.AutomationMovePoint, payload };
    }
    case "automation/deletePoint": {
      const payload: AutomationDeletePointPayload = { pointId: message.pointId };
      return { ...base, type: MessageType.AutomationDeletePoint, payload };
    }

    // Note editing (piano roll)
    case "note/create": {
      const payload: NoteCreatePayload = {
        regionId: message.regionId,
        position: message.position,
        duration: message.duration,
        pitch: message.pitch,
        velocity: message.velocity,
      };
      return { ...base, type: MessageType.NoteCreate, payload };
    }
    case "note/move": {
      const payload: NoteMovePayload = {
        noteId: message.noteId,
        position: message.position,
        pitch: message.pitch,
      };
      return { ...base, type: MessageType.NoteMove, payload };
    }
    case "note/resize": {
      const payload: NoteResizePayload = {
        noteId: message.noteId,
        duration: message.duration,
      };
      return { ...base, type: MessageType.NoteResize, payload };
    }
    case "note/delete": {
      const payload: NoteDeletePayload = { noteId: message.noteId };
      return { ...base, type: MessageType.NoteDelete, payload };
    }
    case "note/setVelocity": {
      const payload: NoteSetVelocityPayload = {
        noteId: message.noteId,
        velocity: message.velocity,
      };
      return { ...base, type: MessageType.NoteSetVelocity, payload };
    }

    // Routing
    case "track/setOutput": {
      const payload: TrackOutputPayload = {
        trackId: message.trackId,
        outputTrackId: message.outputTrackId,
      };
      return { ...base, type: MessageType.TrackSetOutput, payload };
    }
    case "track/addSend": {
      const payload: TrackSendPayload = {
        trackId: message.trackId,
        targetTrackId: message.targetTrackId,
        amount: message.amount ?? 0,
      };
      return { ...base, type: MessageType.TrackAddSend, payload };
    }
    case "track/removeSend": {
      const payload: TrackSendRemovePayload = { sendId: message.sendId };
      return { ...base, type: MessageType.TrackRemoveSend, payload };
    }
    case "track/setSendAmount": {
      const payload: TrackSendAmountPayload = {
        sendId: message.sendId,
        amount: message.amount,
      };
      return { ...base, type: MessageType.TrackSetSendAmount, payload };
    }

    // Unsupported: lifecycle, UI-only, or state-dependent toggles.
    case "view/ready":
    case "transport/toggleLoop":
    case "transport/toggleMetronome":
    case "timeline/selectRegion":
    case "mixer/openDevice":
    case "browser/preview":
    case "browser/dragStart":
    case "command/undo":
    case "command/redo":
    case "command/delete":
    case "command/duplicate":
    case "command/export":
    case "command/importAudio":
    case "command/importMidi":
    case "command/show":
      return undefined;

    default:
      return undefined;
  }
}
