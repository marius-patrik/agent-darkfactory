/**
 * Shared message types for view ↔ extension host communication.
 * Views do not own audio state; every mutation is sent to the host,
 * which broadcasts authoritative state updates.
 */

import type { InsertState as ProtocolInsertState } from "../../shared/protocol.js";

export interface WebviewApi<T = unknown> {
  postMessage(message: T): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface TimePosition {
  bars: number;
  beats: number;
  ticks: number;
  seconds: number;
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface AutomationTarget {
  type: "volume" | "pan" | "device";
  trackId: string;
  deviceId?: string;
  parameter?: string;
}

export interface AutomationPoint {
  id: string;
  laneId: string;
  position: number;
  value: number;
}

export interface AutomationLane {
  id: string;
  trackId: string;
  target: AutomationTarget;
  points: AutomationPoint[];
}

export interface SendState {
  id: string;
  targetTrackId: string;
  targetName?: string;
  amount: number;
}

export interface TrackState {
  id: string;
  name: string;
  color: string;
  muted: boolean;
  soloed: boolean;
  armed: boolean;
  volume: number; // 0..1
  pan: number; // -1..1
  height: number;
  inserts: ProtocolInsertState[];
  regions: RegionState[];
  automationLanes: AutomationLane[];
  outputTrackId?: string | null;
  type?: "audio" | "midi" | "bus" | "master";
  sends: SendState[];
}

export interface RegionState {
  id: string;
  start: number; // beats
  duration: number; // beats
  name: string;
  color: string;
}

export interface NoteState {
  id: string;
  regionId: string;
  start: number; // beats
  duration: number; // beats
  pitch: number; // MIDI note number
  velocity: number; // 0..127
}

export type DeviceCategory = "instrument" | "audio-effect" | "midi-effect";

export interface DeviceItem {
  id: string;
  name: string;
  category: DeviceCategory;
}

export interface BrowserNode {
  id: string;
  name: string;
  type: "folder" | "file" | "device";
  children?: BrowserNode[];
  device?: DeviceItem;
}

export interface DeviceParameter {
  name: string;
  value: number | boolean;
  min: number;
  max: number;
  type: "number" | "boolean";
}

// Messages sent from a view to the extension host
export type ViewMessage =
  | { type: "view/ready"; view: ViewName }
  | { type: "transport/play" }
  | { type: "transport/pause" }
  | { type: "transport/stop" }
  | { type: "transport/record" }
  | { type: "transport/toggleLoop" }
  | { type: "transport/toggleMetronome" }
  | { type: "transport/setTempo"; bpm: number }
  | { type: "transport/setTimeSignature"; timeSignature: TimeSignature }
  | { type: "transport/seek"; beats: number }
  | { type: "track/setMute"; trackId: string; muted: boolean }
  | { type: "track/setSolo"; trackId: string; soloed: boolean }
  | { type: "track/setArm"; trackId: string; armed: boolean }
  | { type: "track/setVolume"; trackId: string; volume: number }
  | { type: "track/setPan"; trackId: string; pan: number }
  | { type: "track/setName"; trackId: string; name: string }
  | { type: "track/create"; trackType: "audio" | "midi" | "bus"; name?: string; color?: string }
  | { type: "track/delete"; trackId: string }
  | { type: "track/setColor"; trackId: string; color: string }
  | {
      type: "track/addInsert";
      trackId: string;
      deviceName: string;
      slot?: DeviceCategory;
      insertIndex?: number;
    }
  | { type: "timeline/selectRegion"; regionId: string | null }
  | { type: "timeline/moveRegion"; regionId: string; start: number }
  | { type: "automation/addLane"; trackId: string; target: AutomationTarget }
  | { type: "automation/removeLane"; laneId: string }
  | { type: "automation/addPoint"; laneId: string; position: number; value: number }
  | { type: "automation/movePoint"; pointId: string; position?: number; value?: number }
  | { type: "automation/deletePoint"; pointId: string }
  | {
      type: "note/create";
      regionId: string;
      position: number;
      duration: number;
      pitch: number;
      velocity: number;
    }
  | { type: "note/move"; noteId: string; position?: number; pitch?: number }
  | { type: "note/resize"; noteId: string; duration: number }
  | { type: "note/delete"; noteId: string }
  | { type: "note/setVelocity"; noteId: string; velocity: number }
  | { type: "mixer/openDevice"; trackId: string; slotIndex: number }
  | { type: "track/setOutput"; trackId: string; outputTrackId: string | null }
  | { type: "track/addSend"; trackId: string; targetTrackId: string; amount?: number }
  | { type: "track/removeSend"; sendId: string }
  | { type: "track/setSendAmount"; sendId: string; amount: number }
  | { type: "device/getParameters"; deviceId: string }
  | { type: "device/setParameter"; deviceId: string; parameter: string; value: number | boolean }
  | { type: "browser/preview"; nodeId: string }
  | { type: "browser/dragStart"; nodeId: string }
  | { type: "command/undo" }
  | { type: "command/redo" }
  | { type: "command/delete" }
  | { type: "command/duplicate" }
  | { type: "command/export" }
  | { type: "command/importAudio" }
  | { type: "command/importMidi" }
  | { type: "command/show"; view: ViewName };

export interface SelectionState {
  trackId?: string;
  regionId?: string;
  noteIds?: string[];
}

// Messages sent from the extension host to views
export type HostMessage =
  | {
      type: "host/transport";
      isPlaying: boolean;
      isRecording: boolean;
      isLooping: boolean;
      isMetronomeEnabled: boolean;
      position: TimePosition;
      bpm: number;
      timeSignature: TimeSignature;
    }
  | { type: "host/tracks"; tracks: TrackState[] }
  | ({ type: "host/selection" } & SelectionState)
  | { type: "host/browser"; root: BrowserNode }
  | { type: "host/deviceParameters"; deviceId: string; parameters: DeviceParameter[] }
  | { type: "host/notes"; notes: NoteState[] }
  | { type: "host/project"; name: string; saved: boolean }
  | { type: "host/error"; message: string };

export type ViewName = "timeline" | "mixer" | "pianoRoll" | "browser" | "graph";
