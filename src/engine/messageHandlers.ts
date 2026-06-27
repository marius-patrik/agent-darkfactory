import {
  type AudioImportPayload,
  type DeviceCreatePayload,
  type DeviceIdPayload,
  type DeviceListPayload,
  type DeviceMovePayload,
  type DeviceParameterPayload,
  type ExportAudioPayload,
  type ExportRenderPayload,
  type Message,
  MessageType,
  type MidiAddNotePayload,
  type MidiInputPayload,
  type MidiMoveNotePayload,
  type MidiNoteIdPayload,
  type MidiNoteVelocityPayload,
  type MidiResizeNotePayload,
  type NoteCreatePayload,
  type NoteDeletePayload,
  type NoteMovePayload,
  type NoteResizePayload,
  type NoteSetVelocityPayload,
  type PeaksGetPayload,
  type ProjectLoadPayload,
  type ProjectNewPayload,
  type ProjectSavePayload,
  type RecordingCompPayload,
  type RecordingStartPayload,
  type RegionCreateAudioPayload,
  type RegionCreateMidiPayload,
  type RegionFadePayload,
  type RegionIdPayload,
  type RegionMovePayload,
  type RegionResizePayload,
  type RegionSplitPayload,
  type StateSetPayload,
  type TrackBooleanPayload,
  type TrackColorPayload,
  type TrackCreatePayload,
  type TrackIdPayload,
  type TrackInsertMovePayload,
  type TrackInsertPayload,
  type TrackInsertRemovePayload,
  type TrackNamePayload,
  type TrackPanPayload,
  type TrackReorderPayload,
  type TrackVolumePayload,
  type TransportLoopPayload,
  type TransportSeekPayload,
  type TransportTempoPayload,
  type TransportTimeSignaturePayload,
} from "../shared/protocol.js";
import type { ProjectController } from "./projectAdapter.js";

export type HandlerResult = { type: "ok"; payload?: unknown } | { type: "error"; message: string };

function log(direction: string, message: string) {
  console.log(`[VSDAW engine] ${direction}: ${message}`);
}

export function handleMessage(
  controller: ProjectController,
  message: Message,
): Promise<HandlerResult> | HandlerResult {
  try {
    return routeMessage(controller, message);
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);
    log("handler", `uncaught error for ${message.type}: ${messageText}`);
    return { type: "error", message: messageText };
  }
}

function routeMessage(
  controller: ProjectController,
  message: Message,
): Promise<HandlerResult> | HandlerResult {
  const p = message.payload;
  switch (message.type) {
    // Project lifecycle
    case MessageType.ProjectNew: {
      const opts = (p ?? {}) as ProjectNewPayload;
      controller.newProject(opts.bpm, opts.timeSignature);
      return { type: "ok" };
    }
    case MessageType.ProjectLoad: {
      const opts = p as ProjectLoadPayload;
      if (!opts?.data) {
        return { type: "error", message: "Project data is required" };
      }
      const binary = base64ToArrayBuffer(opts.data);
      controller.loadProject(binary);
      return { type: "ok" };
    }
    case MessageType.ProjectSave: {
      const opts = (p ?? {}) as ProjectSavePayload;
      const buffer = controller.serializeProject();
      if (opts.format === "arraybuffer") {
        return { type: "ok", payload: buffer };
      }
      return { type: "ok", payload: arrayBufferToBase64(buffer) };
    }
    case MessageType.ProjectClose: {
      controller.closeProject();
      return { type: "ok" };
    }

    // Transport
    case MessageType.TransportPlay:
      controller.play();
      return { type: "ok" };
    case MessageType.TransportPause:
      controller.pause();
      return { type: "ok" };
    case MessageType.TransportStop:
      controller.stop();
      return { type: "ok" };
    case MessageType.TransportRecord:
      controller.record();
      return { type: "ok" };
    case MessageType.TransportSeek: {
      const opts = p as TransportSeekPayload;
      if (opts?.position == null) {
        return { type: "error", message: "Seek position is required" };
      }
      controller.seek(opts.position, opts.unit);
      return { type: "ok" };
    }
    case MessageType.TransportSetLoop: {
      const opts = p as TransportLoopPayload;
      controller.setLoop(opts.enabled, opts.start, opts.end);
      return { type: "ok" };
    }
    case MessageType.TransportSetTempo: {
      const opts = p as TransportTempoPayload;
      if (opts?.bpm == null || opts.bpm <= 0) {
        return { type: "error", message: "Valid BPM is required" };
      }
      controller.setTempo(opts.bpm);
      return { type: "ok" };
    }
    case MessageType.TransportSetTimeSignature: {
      const opts = p as TransportTimeSignaturePayload;
      if (opts?.numerator == null || opts?.denominator == null || opts.denominator <= 0) {
        return { type: "error", message: "Valid time signature is required" };
      }
      controller.setTimeSignature(opts.numerator, opts.denominator);
      return { type: "ok" };
    }

    // Tracks
    case MessageType.TrackCreate: {
      const opts = p as TrackCreatePayload;
      if (!opts?.type) {
        return { type: "error", message: "Track type is required" };
      }
      const id = controller.createTrack(opts.type, opts.name, opts.index, opts.color);
      return { type: "ok", payload: { trackId: id } };
    }
    case MessageType.TrackDelete: {
      const opts = p as TrackIdPayload;
      if (!opts?.trackId) {
        return { type: "error", message: "trackId is required" };
      }
      controller.deleteTrack(opts.trackId);
      return { type: "ok" };
    }
    case MessageType.TrackReorder: {
      const opts = p as TrackReorderPayload;
      if (!opts?.trackId || opts.newIndex == null) {
        return { type: "error", message: "trackId and newIndex are required" };
      }
      controller.reorderTrack(opts.trackId, opts.newIndex);
      return { type: "ok" };
    }
    case MessageType.TrackSetName: {
      const opts = p as TrackNamePayload;
      if (!opts?.trackId || opts.name == null) {
        return { type: "error", message: "trackId and name are required" };
      }
      controller.setTrackName(opts.trackId, opts.name);
      return { type: "ok" };
    }
    case MessageType.TrackSetColor: {
      const opts = p as TrackColorPayload;
      if (!opts?.trackId || opts.color == null) {
        return { type: "error", message: "trackId and color are required" };
      }
      controller.setTrackColor(opts.trackId, opts.color);
      return { type: "ok" };
    }
    case MessageType.TrackSetVolumeDb: {
      const opts = p as TrackVolumePayload;
      if (!opts?.trackId || opts.volumeDb == null) {
        return { type: "error", message: "trackId and volumeDb are required" };
      }
      controller.setTrackVolumeDb(opts.trackId, opts.volumeDb);
      return { type: "ok" };
    }
    case MessageType.TrackSetPan: {
      const opts = p as TrackPanPayload;
      if (!opts?.trackId || opts.pan == null) {
        return { type: "error", message: "trackId and pan are required" };
      }
      controller.setTrackPan(opts.trackId, opts.pan);
      return { type: "ok" };
    }
    case MessageType.TrackSetMute: {
      const opts = p as TrackBooleanPayload;
      if (!opts?.trackId || opts.value == null) {
        return { type: "error", message: "trackId and value are required" };
      }
      controller.setTrackMute(opts.trackId, opts.value);
      return { type: "ok" };
    }
    case MessageType.TrackSetSolo: {
      const opts = p as TrackBooleanPayload;
      if (!opts?.trackId || opts.value == null) {
        return { type: "error", message: "trackId and value are required" };
      }
      controller.setTrackSolo(opts.trackId, opts.value);
      return { type: "ok" };
    }
    case MessageType.TrackSetArm: {
      const opts = p as TrackBooleanPayload;
      if (!opts?.trackId || opts.value == null) {
        return { type: "error", message: "trackId and value are required" };
      }
      controller.setTrackArm(opts.trackId, opts.value);
      return { type: "ok" };
    }
    case MessageType.TrackAddInsert: {
      const opts = p as TrackInsertPayload;
      if (!opts?.trackId || !opts.deviceName) {
        return { type: "error", message: "trackId and deviceName are required" };
      }
      const id = controller.createDevice(
        opts.slot ?? "audio-effect",
        opts.deviceName,
        opts.trackId,
        opts.insertIndex,
      );
      return { type: "ok", payload: { insertId: id } };
    }
    case MessageType.TrackRemoveInsert: {
      const opts = p as TrackInsertRemovePayload;
      if (!opts?.insertId) {
        return { type: "error", message: "insertId is required" };
      }
      controller.deleteDevice(opts.insertId);
      return { type: "ok" };
    }
    case MessageType.TrackMoveInsert: {
      const opts = p as TrackInsertMovePayload;
      if (!opts?.insertId || opts.newIndex == null) {
        return { type: "error", message: "insertId and newIndex are required" };
      }
      controller.moveDevice(opts.insertId, opts.newIndex);
      return { type: "ok" };
    }
    case MessageType.TrackSetInsertParameter: {
      const opts = p as DeviceParameterPayload;
      if (!opts?.deviceId || opts.parameter == null || opts.value == null) {
        return { type: "error", message: "deviceId, parameter and value are required" };
      }
      controller.setDeviceParameter(opts.deviceId, opts.parameter, opts.value);
      return { type: "ok" };
    }

    // Regions
    case MessageType.RegionCreateAudio: {
      const opts = p as RegionCreateAudioPayload;
      if (!opts?.trackId || opts.position == null) {
        return { type: "error", message: "trackId and position are required" };
      }
      // The host must have imported the audio file first and pass the sample record.
      // For the protocol we accept a serialized sample object in the payload.
      const sample = (p as any).sample ?? {
        uuid: opts.audioFileId,
        name: opts.name ?? "audio",
        duration: opts.duration ?? 0,
        bpm: 120,
      };
      if (!sample.uuid || sample.duration == null || sample.bpm == null) {
        return { type: "error", message: "Audio sample metadata is incomplete" };
      }
      const id = controller.createAudioRegion(
        opts.trackId,
        sample,
        opts.position,
        opts.duration,
        opts.offset,
        opts.name,
      );
      return { type: "ok", payload: { regionId: id } };
    }
    case MessageType.RegionCreateMidi: {
      const opts = p as RegionCreateMidiPayload;
      if (!opts?.trackId || opts.position == null || opts.duration == null) {
        return { type: "error", message: "trackId, position and duration are required" };
      }
      const id = controller.createMidiRegion(opts.trackId, opts.position, opts.duration, opts.name);
      return { type: "ok", payload: { regionId: id } };
    }
    case MessageType.RegionMove: {
      const opts = p as RegionMovePayload;
      if (!opts?.regionId || opts.position == null) {
        return { type: "error", message: "regionId and position are required" };
      }
      controller.moveRegion(opts.regionId, opts.position, opts.trackId);
      return { type: "ok" };
    }
    case MessageType.RegionResize: {
      const opts = p as RegionResizePayload;
      if (!opts?.regionId || opts.duration == null) {
        return { type: "error", message: "regionId and duration are required" };
      }
      controller.resizeRegion(opts.regionId, opts.duration);
      return { type: "ok" };
    }
    case MessageType.RegionSplit: {
      const opts = p as RegionSplitPayload;
      if (!opts?.regionId || opts.position == null) {
        return { type: "error", message: "regionId and position are required" };
      }
      const ids = controller.splitRegion(opts.regionId, opts.position);
      return { type: "ok", payload: { regionIds: ids } };
    }
    case MessageType.RegionSetFadeIn: {
      const opts = p as RegionFadePayload;
      if (!opts?.regionId || opts.value == null) {
        return { type: "error", message: "regionId and value are required" };
      }
      controller.setFadeIn(opts.regionId, opts.value);
      return { type: "ok" };
    }
    case MessageType.RegionSetFadeOut: {
      const opts = p as RegionFadePayload;
      if (!opts?.regionId || opts.value == null) {
        return { type: "error", message: "regionId and value are required" };
      }
      controller.setFadeOut(opts.regionId, opts.value);
      return { type: "ok" };
    }
    case MessageType.RegionDelete: {
      const opts = p as RegionIdPayload;
      if (!opts?.regionId) {
        return { type: "error", message: "regionId is required" };
      }
      controller.deleteRegion(opts.regionId);
      return { type: "ok" };
    }

    // MIDI
    case MessageType.MidiAddNote: {
      const opts = p as MidiAddNotePayload;
      if (
        !opts?.regionId ||
        opts.position == null ||
        opts.duration == null ||
        opts.pitch == null ||
        opts.velocity == null
      ) {
        return {
          type: "error",
          message: "regionId, position, duration, pitch and velocity are required",
        };
      }
      const id = controller.addNote(
        opts.regionId,
        opts.position,
        opts.duration,
        opts.pitch,
        opts.velocity,
      );
      return { type: "ok", payload: { noteId: id } };
    }
    case MessageType.MidiMoveNote: {
      const opts = p as MidiMoveNotePayload;
      if (!opts?.noteId) {
        return { type: "error", message: "noteId is required" };
      }
      controller.moveNote(opts.noteId, opts.position, opts.pitch);
      return { type: "ok" };
    }
    case MessageType.MidiResizeNote: {
      const opts = p as MidiResizeNotePayload;
      if (!opts?.noteId || opts.duration == null) {
        return { type: "error", message: "noteId and duration are required" };
      }
      controller.resizeNote(opts.noteId, opts.duration);
      return { type: "ok" };
    }
    case MessageType.MidiDeleteNote: {
      const opts = p as MidiNoteIdPayload;
      if (!opts?.noteId) {
        return { type: "error", message: "noteId is required" };
      }
      controller.deleteNote(opts.noteId);
      return { type: "ok" };
    }
    case MessageType.MidiSetNoteVelocity: {
      const opts = p as MidiNoteVelocityPayload;
      if (!opts?.noteId || opts.velocity == null) {
        return { type: "error", message: "noteId and velocity are required" };
      }
      controller.setNoteVelocity(opts.noteId, opts.velocity);
      return { type: "ok" };
    }
    case MessageType.MidiInput: {
      const opts = p as MidiInputPayload;
      if (!opts?.deviceId || !Array.isArray(opts.data) || opts.data.length === 0) {
        return { type: "error", message: "deviceId and data are required" };
      }
      controller.handleMidiInput(
        opts.deviceId,
        new Uint8Array(opts.data),
        opts.timestamp ?? performance.now(),
      );
      return { type: "ok" };
    }

    // Note editing (piano roll)
    case MessageType.NoteCreate: {
      const opts = p as NoteCreatePayload;
      if (
        !opts?.regionId ||
        opts.position == null ||
        opts.duration == null ||
        opts.pitch == null ||
        opts.velocity == null
      ) {
        return {
          type: "error",
          message: "regionId, position, duration, pitch and velocity are required",
        };
      }
      const id = controller.addNote(
        opts.regionId,
        opts.position,
        opts.duration,
        opts.pitch,
        opts.velocity,
      );
      return { type: "ok", payload: { noteId: id } };
    }
    case MessageType.NoteMove: {
      const opts = p as NoteMovePayload;
      if (!opts?.noteId) {
        return { type: "error", message: "noteId is required" };
      }
      controller.moveNote(opts.noteId, opts.position, opts.pitch);
      return { type: "ok" };
    }
    case MessageType.NoteResize: {
      const opts = p as NoteResizePayload;
      if (!opts?.noteId || opts.duration == null) {
        return { type: "error", message: "noteId and duration are required" };
      }
      controller.resizeNote(opts.noteId, opts.duration);
      return { type: "ok" };
    }
    case MessageType.NoteDelete: {
      const opts = p as NoteDeletePayload;
      if (!opts?.noteId) {
        return { type: "error", message: "noteId is required" };
      }
      controller.deleteNote(opts.noteId);
      return { type: "ok" };
    }
    case MessageType.NoteSetVelocity: {
      const opts = p as NoteSetVelocityPayload;
      if (!opts?.noteId || opts.velocity == null) {
        return { type: "error", message: "noteId and velocity are required" };
      }
      controller.setNoteVelocity(opts.noteId, opts.velocity);
      return { type: "ok" };
    }

    // Recording
    case MessageType.RecordingStart: {
      const opts = (p ?? {}) as RecordingStartPayload;
      return controller
        .startRecording(opts.trackIds, opts.countIn)
        .then(() => ({ type: "ok" as const }))
        .catch((error: unknown) => ({
          type: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    }
    case MessageType.RecordingStop: {
      controller.stopRecording();
      return { type: "ok" };
    }
    case MessageType.RecordingComp: {
      const opts = p as RecordingCompPayload;
      if (!opts?.takeRegionIds || !opts.activeRegionId) {
        return { type: "error", message: "takeRegionIds and activeRegionId are required" };
      }
      controller.compTakes(opts.takeRegionIds, opts.activeRegionId);
      return { type: "ok" };
    }

    // Devices
    case MessageType.DeviceCreate: {
      const opts = p as DeviceCreatePayload;
      if (!opts?.slot || !opts.factoryName) {
        return { type: "error", message: "slot and factoryName are required" };
      }
      const id = controller.createDevice(
        opts.slot,
        opts.factoryName,
        opts.trackId,
        opts.insertIndex,
      );
      return { type: "ok", payload: { deviceId: id } };
    }
    case MessageType.DeviceDelete: {
      const opts = p as DeviceIdPayload;
      if (!opts?.deviceId) {
        return { type: "error", message: "deviceId is required" };
      }
      controller.deleteDevice(opts.deviceId);
      return { type: "ok" };
    }
    case MessageType.DeviceMove: {
      const opts = p as DeviceMovePayload;
      if (!opts?.deviceId || opts.newIndex == null) {
        return { type: "error", message: "deviceId and newIndex are required" };
      }
      controller.moveDevice(opts.deviceId, opts.newIndex);
      return { type: "ok" };
    }
    case MessageType.DeviceSetParameter: {
      const opts = p as DeviceParameterPayload;
      if (!opts?.deviceId || opts.parameter == null || opts.value == null) {
        return { type: "error", message: "deviceId, parameter and value are required" };
      }
      controller.setDeviceParameter(opts.deviceId, opts.parameter, opts.value);
      return { type: "ok" };
    }
    case MessageType.DeviceList: {
      const opts = (p ?? {}) as DeviceListPayload;
      const devices = controller.listDevices();
      const payload = opts.category
        ? devices.filter((device) => device.category === opts.category)
        : devices;
      return { type: "ok", payload };
    }
    case MessageType.DeviceGetParameters: {
      const opts = p as DeviceIdPayload;
      if (!opts?.deviceId) {
        return { type: "error", message: "deviceId is required" };
      }
      return { type: "ok", payload: controller.getDeviceParameters(opts.deviceId) };
    }

    // Audio import
    case MessageType.AudioImport: {
      const opts = p as AudioImportPayload;
      if (!opts?.data) {
        return { type: "error", message: "Audio data is required" };
      }
      const binary = base64ToArrayBuffer(opts.data);
      return controller
        .importAudioFile(binary, opts.name)
        .then((result) => ({ type: "ok" as const, payload: result }))
        .catch((error: unknown) => ({
          type: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    }

    // Peaks
    case MessageType.PeaksGet: {
      const opts = p as PeaksGetPayload;
      if (!opts?.sampleId || opts.width == null) {
        return { type: "error", message: "sampleId and width are required" };
      }
      return controller
        .getPeaks(opts.sampleId, opts.width, opts.channel)
        .then((result) => ({ type: "ok" as const, payload: result }))
        .catch((error: unknown) => ({
          type: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    }

    // Export
    case MessageType.ExportRender: {
      const opts = p as ExportRenderPayload;
      if (!opts?.format) {
        return { type: "error", message: "format is required" };
      }
      return controller
        .renderExport(opts.format, opts.start, opts.end, opts.fileName, opts.stems)
        .then((result) => ({ type: "ok" as const, payload: result }))
        .catch((error: unknown) => ({
          type: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    }
    case MessageType.ExportAudio: {
      const opts = p as ExportAudioPayload;
      if (!opts?.format) {
        return { type: "error", message: "format is required" };
      }
      return controller
        .renderExport(opts.format, opts.start, opts.end, undefined, opts.stems)
        .then((result) => ({ type: "ok" as const, payload: result }))
        .catch((error: unknown) => ({
          type: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    }

    // State
    case MessageType.StateGet: {
      return { type: "ok", payload: controller.getState() };
    }
    case MessageType.StateSet: {
      const opts = p as StateSetPayload;
      if (!opts?.data) {
        return { type: "error", message: "State data is required" };
      }
      const binary = base64ToArrayBuffer(opts.data);
      controller.loadProject(binary);
      return { type: "ok" };
    }

    default:
      log("handler", `unknown message type: ${message.type}`);
      return { type: "error", message: `Unknown message type: ${message.type}` };
  }
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
