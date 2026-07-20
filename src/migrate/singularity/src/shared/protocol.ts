import { z } from "zod";

export const MessageDirectionSchema = z.enum([
  "host-to-engine",
  "engine-to-host",
  "view-to-host",
  "host-to-view",
]);

export const MessageSchema = z.object({
  projectId: z.string().min(1),
  direction: MessageDirectionSchema,
  type: z.string().min(1),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export interface Message<T = unknown> {
  projectId: string;
  direction: MessageDirection;
  type: string;
  payload?: T;
  requestId?: string;
}

export type MessageEnvelope = Message;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function serialize(envelope: MessageEnvelope): string {
  const result = MessageSchema.safeParse(envelope);
  if (!result.success) {
    throw new ProtocolError(`Invalid envelope: ${result.error.message}`);
  }
  return JSON.stringify(result.data);
}

export function deserialize(input: unknown): MessageEnvelope {
  let parsed: unknown;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new ProtocolError("Invalid JSON");
    }
  } else {
    parsed = input;
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new ProtocolError("Envelope must be an object");
  }

  const result = MessageSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProtocolError(`Invalid envelope: ${result.error.message}`);
  }
  return result.data;
}

export function parseMessage(data: unknown): MessageEnvelope {
  return deserialize(data);
}

export function isEngineMessage(data: unknown): data is Message {
  if (data === null || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.projectId === "string" &&
    record.direction === "host-to-engine" &&
    typeof record.type === "string"
  );
}

export enum MessageType {
  EngineReady = "ready",
  EngineError = "error",

  Ping = "ping",
  Pong = "pong",

  ProjectNew = "project.new",
  ProjectLoad = "project.load",
  ProjectSave = "project.save",
  ProjectClose = "project.close",

  TransportPlay = "transport.play",
  TransportPause = "transport.pause",
  TransportStop = "transport.stop",
  TransportRecord = "transport.record",
  TransportSeek = "transport.seek",
  TransportSetLoop = "transport.setLoop",
  TransportSetTempo = "transport.setTempo",
  TransportSetTimeSignature = "transport.setTimeSignature",
  TransportPositionChanged = "transport.positionChanged",

  TrackCreate = "track.create",
  TrackDelete = "track.delete",
  TrackReorder = "track.reorder",
  TrackSetName = "track.setName",
  TrackSetColor = "track.setColor",
  TrackSetVolumeDb = "track.setVolumeDb",
  TrackSetPan = "track.setPan",
  TrackSetMute = "track.setMute",
  TrackSetSolo = "track.setSolo",
  TrackSetArm = "track.setArm",
  TrackAddInsert = "track.addInsert",
  TrackRemoveInsert = "track.removeInsert",
  TrackMoveInsert = "track.moveInsert",
  TrackSetInsertParameter = "track.setInsertParameter",
  TrackSetOutput = "track.setOutput",
  TrackAddSend = "track.addSend",
  TrackRemoveSend = "track.removeSend",
  TrackSetSendAmount = "track.setSendAmount",
  TrackSetInputDevice = "track.setInputDevice",

  RegionCreateAudio = "region.createAudio",
  RegionCreateMidi = "region.createMidi",
  RegionMove = "region.move",
  RegionResize = "region.resize",
  RegionSplit = "region.split",
  RegionSetFadeIn = "region.setFadeIn",
  RegionSetFadeOut = "region.setFadeOut",
  RegionDelete = "region.delete",

  MidiAddNote = "midi.addNote",
  MidiMoveNote = "midi.moveNote",
  MidiResizeNote = "midi.resizeNote",
  MidiDeleteNote = "midi.deleteNote",
  MidiSetNoteVelocity = "midi.setNoteVelocity",
  MidiInput = "midi.input",

  NoteCreate = "note.create",
  NoteMove = "note.move",
  NoteResize = "note.resize",
  NoteDelete = "note.delete",
  NoteSetVelocity = "note.setVelocity",

  AutomationAddLane = "automation.addLane",
  AutomationRemoveLane = "automation.removeLane",
  AutomationAddPoint = "automation.addPoint",
  AutomationMovePoint = "automation.movePoint",
  AutomationDeletePoint = "automation.deletePoint",

  RecordingStart = "recording.start",
  RecordingStop = "recording.stop",
  RecordingComp = "recording.comp",

  DeviceCreate = "device.create",
  DeviceDelete = "device.delete",
  DeviceMove = "device.move",
  DeviceSetParameter = "device.setParameter",
  DeviceList = "device.list",
  DeviceGetParameters = "device.getParameters",

  PluginScan = "plugin.scan",

  PeaksGet = "peaks.get",

  AudioImport = "audio.import",

  ExportRender = "export.render",
  ExportAudio = "export.audio",

  StateGet = "state.get",
  StateSet = "state.set",
  StateUpdate = "state.update",
}

export interface EngineReadyPayload {
  crossOriginIsolated: boolean;
  audioContextState: AudioContextState;
  sampleRate: number;
}

export interface EngineErrorPayload {
  message: string;
  stack?: string;
}

export interface ProjectNewPayload {
  bpm?: number;
  timeSignature?: [number, number];
}

export interface ProjectLoadPayload {
  data: string;
}

export interface ProjectSavePayload {
  format?: "arraybuffer" | "base64";
}

export interface StateSetPayload {
  /** Base64-encoded engine project binary. */
  data: string;
}

export interface TransportSeekPayload {
  position: number;
  unit?: "ppqn" | "seconds" | "bars";
}

export interface TransportLoopPayload {
  enabled: boolean;
  start?: number;
  end?: number;
}

export interface TransportTempoPayload {
  bpm: number;
}

export interface TransportTimeSignaturePayload {
  numerator: number;
  denominator: number;
}

export interface TrackCreatePayload {
  type: TrackType;
  name?: string;
  index?: number;
  color?: string;
}

export interface TrackIdPayload {
  trackId: string;
}

export interface TrackReorderPayload {
  trackId: string;
  newIndex: number;
}

export interface TrackNamePayload {
  trackId: string;
  name: string;
}

export interface TrackColorPayload {
  trackId: string;
  color: string;
}

export interface TrackVolumePayload {
  trackId: string;
  volumeDb: number;
}

export interface TrackPanPayload {
  trackId: string;
  pan: number;
}

export interface TrackBooleanPayload {
  trackId: string;
  value: boolean;
}

export interface TrackInsertPayload {
  trackId: string;
  deviceName: string;
  insertIndex?: number;
  slot?: DeviceCategory;
}

export interface TrackInsertRemovePayload {
  insertId: string;
}

export interface TrackInsertMovePayload {
  insertId: string;
  newIndex: number;
}

export interface TrackOutputPayload {
  trackId: string;
  outputTrackId: string | null;
}

export interface TrackSendPayload {
  trackId: string;
  targetTrackId: string;
  amount?: number;
}

export interface TrackSendRemovePayload {
  sendId: string;
}

export interface TrackSendAmountPayload {
  sendId: string;
  amount: number;
}

export interface TrackInputDevicePayload {
  trackId: string;
  inputDeviceId: string;
}

export interface RegionCreateAudioPayload {
  trackId: string;
  audioFileId: string;
  position: number;
  duration?: number;
  offset?: number;
  name?: string;
  sample?: unknown;
}

export interface RegionCreateMidiPayload {
  trackId: string;
  position: number;
  duration: number;
  name?: string;
}

export interface RegionMovePayload {
  regionId: string;
  position: number;
  trackId?: string;
}

export interface RegionResizePayload {
  regionId: string;
  duration: number;
}

export interface RegionSplitPayload {
  regionId: string;
  position: number;
}

export interface RegionFadePayload {
  regionId: string;
  value: number;
}

export interface RegionIdPayload {
  regionId: string;
}

export interface MidiAddNotePayload {
  regionId: string;
  position: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface MidiMoveNotePayload {
  noteId: string;
  position?: number;
  pitch?: number;
}

export interface MidiResizeNotePayload {
  noteId: string;
  duration: number;
}

export interface MidiNoteIdPayload {
  noteId: string;
}

export interface MidiNoteVelocityPayload {
  noteId: string;
  velocity: number;
}

export interface NoteCreatePayload {
  regionId: string;
  position: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface NoteMovePayload {
  noteId: string;
  position?: number;
  pitch?: number;
}

export interface NoteResizePayload {
  noteId: string;
  duration: number;
}

export interface NoteDeletePayload {
  noteId: string;
}

export interface NoteSetVelocityPayload {
  noteId: string;
  velocity: number;
}

export interface MidiInputPayload {
  deviceId: string;
  data: number[];
  timestamp?: number;
}

export interface AutomationTarget {
  type: "volume" | "pan" | "device";
  trackId: string;
  deviceId?: string;
  parameter?: string;
}

export interface AutomationAddLanePayload {
  laneId?: string;
  trackId: string;
  target: AutomationTarget;
}

export interface AutomationRemoveLanePayload {
  laneId: string;
}

export interface AutomationAddPointPayload {
  laneId: string;
  position: number;
  value: number;
}

export interface AutomationMovePointPayload {
  pointId: string;
  position?: number;
  value?: number;
}

export interface AutomationDeletePointPayload {
  pointId: string;
}

export interface RecordingStartPayload {
  trackIds?: string[];
  countIn?: boolean;
}

export interface RecordingCompPayload {
  takeRegionIds: string[];
  activeRegionId: string;
}

export interface DeviceCreatePayload {
  slot: "instrument" | "audio-effect" | "midi-effect";
  factoryName: string;
  trackId?: string;
  insertIndex?: number;
}

export interface DeviceIdPayload {
  deviceId: string;
}

export interface DeviceMovePayload {
  deviceId: string;
  newIndex: number;
}

export interface DeviceParameterPayload {
  deviceId: string;
  parameter: string;
  value: number | boolean;
}

export type DeviceCategory = "instrument" | "audio-effect" | "midi-effect";

export interface DeviceListItem {
  id: string;
  name: string;
  category: DeviceCategory;
}

export interface PluginState {
  id: string;
  name: string;
  vendor?: string;
  category: DeviceCategory;
  path?: string;
}

export interface DeviceListPayload {
  category?: DeviceCategory;
}

export interface DeviceParameterDescriptor {
  name: string;
  value: number | boolean;
  min: number | boolean;
  max: number | boolean;
  type: "number" | "boolean";
}

export interface PeaksGetPayload {
  sampleId: string;
  width: number;
  channel?: number;
}

export interface AudioImportPayload {
  data: string;
  name?: string;
  bpm?: number;
}

export interface ExportRenderPayload {
  format: ExportFormat;
  start?: number;
  end?: number;
  fileName?: string;
  stems?: boolean;
}

export interface ExportAudioPayload {
  format: ExportFormat;
  start?: number;
  end?: number;
  stems?: boolean;
}

export type TrackType = "audio" | "midi" | "bus" | "master";

export type ExportFormat = "wav" | "flac" | "ogg" | "mp3";

export interface InsertState {
  id: string;
  name: string;
  type: "audio-effect" | "midi-effect" | "instrument";
  enabled: boolean;
  index: number;
}

export interface SendState {
  id: string;
  targetTrackId: string;
  amount: number;
}

export interface TrackState {
  id: string;
  type: TrackType;
  name: string;
  color?: string;
  index: number;
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  inserts: InsertState[];
  outputTrackId?: string | null;
  inputDeviceId?: string;
  sends: SendState[];
}

export interface RegionState {
  id: string;
  trackId: string;
  type: "audio" | "midi";
  position: number;
  duration: number;
  name: string;
  hue: number;
  offset?: number;
  fadeIn?: unknown;
  fadeOut?: unknown;
}

export interface NoteState {
  id: string;
  regionId: string;
  position: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface TransportState {
  isPlaying: boolean;
  isRecording: boolean;
  isLooping: boolean;
  position: number;
  bpm: number;
  timeSignature: [number, number];
  loopStart: number;
  loopEnd: number;
}

export interface AutomationLaneState {
  id: string;
  trackId: string;
  target: AutomationTarget;
}

export interface AutomationPointState {
  id: string;
  laneId: string;
  position: number;
  value: number;
}

export interface ProjectState {
  projectId: string;
  tracks: TrackState[];
  regions: RegionState[];
  notes: NoteState[];
  automationLanes: AutomationLaneState[];
  automationPoints: AutomationPointState[];
  plugins: PluginState[];
  transport: TransportState;
}

export interface PeaksResultPayload {
  sampleId: string;
  channel: number;
  peaks: Float32Array;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
}

export interface ExportRenderResult {
  format: ExportFormat;
  data: string;
  fileName: string;
  message?: string;
}

export interface ExportAudioResult {
  format: ExportFormat;
  data: string;
  fileName: string;
  message?: string;
}
