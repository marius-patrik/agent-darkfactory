import { AUTOMATION_LANE_HEIGHT } from "../shared/automation.js";
import {
  type AutomationLaneState as EngineAutomationLaneState,
  type AutomationPointState as EngineAutomationPointState,
  type DeviceListItem,
  type NoteState as EngineNoteState,
  type RegionState as EngineRegionState,
  type TrackState as EngineTrackState,
  MessageType,
  type ProjectState,
  type TransportState,
} from "../shared/protocol.js";
import { DEFAULT_PPQN, ppqnToBarsBeatsTicks, ppqnToSeconds } from "../shared/time.js";
import type {
  BrowserNode,
  HostMessage,
  NoteState as ViewNoteState,
  SelectionState,
  TimePosition,
  RegionState as ViewRegionState,
  TrackState as ViewTrackState,
} from "../views/shared/types.js";
import type { MessageRouter } from "./messageRouter.js";

const MIN_VOLUME_DB = -120;
const DEFAULT_TRACK_HEIGHT = 48;

export interface ProjectStateProjectorOptions {
  projectId: string;
  router: MessageRouter;
  getProjectName: () => string;
  getSaved: () => boolean;
  throttleMs?: number;
}

function dbToLinear(volumeDb: number): number {
  if (volumeDb <= MIN_VOLUME_DB) return 0;
  return Math.max(0, Math.min(1, 10 ** (volumeDb / 20)));
}

function defaultTrackColor(index: number): string {
  return `hsl(${(index * 47) % 360}, 70%, 50%)`;
}

function regionColor(hue: number): string {
  return `hsl(${hue}, 70%, 50%)`;
}

export class ProjectStateProjector {
  private projectId: string;
  private router: MessageRouter;
  private getProjectName: () => string;
  private getSaved: () => boolean;
  private throttleMs: number;
  private projectState?: ProjectState;
  private lastTransport?: HostMessage & { type: "host/transport" };
  private selection: SelectionState = {};
  private pendingPosition?: number;
  private throttleTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ProjectStateProjectorOptions) {
    this.projectId = options.projectId;
    this.router = options.router;
    this.getProjectName = options.getProjectName;
    this.getSaved = options.getSaved;
    this.throttleMs = options.throttleMs ?? 50;
  }

  dispose(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
  }

  handleStateUpdate(state: ProjectState): void {
    this.projectState = state;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
      this.pendingPosition = undefined;
    }

    const transport = this.buildTransportMessage(state.transport);
    this.lastTransport = transport;
    this.broadcast(transport);

    const tracks = this.buildTracksMessage(state);
    this.broadcast(tracks);

    const notes = this.buildNotesMessage(state);
    this.broadcast(notes);
  }

  handleTransportPositionChanged(position: number): void {
    this.pendingPosition = position;
    if (this.throttleTimer) return;

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      const pending = this.pendingPosition;
      this.pendingPosition = undefined;
      if (pending === undefined) return;

      const base = this.lastTransport;
      if (!base) return;

      const timeSignature: [number, number] = [
        base.timeSignature.numerator,
        base.timeSignature.denominator,
      ];
      const updated: HostMessage & { type: "host/transport" } = {
        ...base,
        position: this.buildTimePosition(pending, base.bpm, timeSignature),
      };
      this.lastTransport = updated;
      this.broadcast(updated);
    }, this.throttleMs);
  }

  updateSelection(selection: Partial<SelectionState>): void {
    const next: SelectionState = { ...this.selection };
    if ("trackId" in selection) {
      if (selection.trackId === undefined || selection.trackId === null) {
        next.trackId = undefined;
      } else {
        next.trackId = selection.trackId;
      }
    }
    if ("regionId" in selection) {
      if (selection.regionId === undefined || selection.regionId === null) {
        next.regionId = undefined;
      } else {
        next.regionId = selection.regionId;
      }
    }
    if (selection.noteIds) {
      next.noteIds = selection.noteIds;
    } else if ("noteIds" in selection && selection.noteIds === undefined) {
      next.noteIds = undefined;
    }

    if (selectionEquals(next, this.selection)) return;

    this.selection = next;
    this.broadcast({ type: "host/selection", ...next });
  }

  broadcastProject(): void {
    this.broadcast({
      type: "host/project",
      name: this.getProjectName(),
      saved: this.getSaved(),
    });
  }

  async requestDeviceList(): Promise<void> {
    try {
      const response = await this.router.requestEngine(
        this.projectId,
        MessageType.DeviceList,
        undefined,
        { responseType: MessageType.DeviceList, timeoutMs: 10000 },
      );
      const devices = (response.payload as DeviceListItem[] | undefined) ?? [];
      this.broadcast({ type: "host/browser", root: buildBrowserRoot(devices) });
    } catch (error) {
      console.error("[projector] device list request failed", error);
    }
  }

  private broadcast(message: HostMessage): void {
    this.router.broadcastToViews(this.projectId, message);
  }

  private buildTransportMessage(
    transport: TransportState,
  ): HostMessage & { type: "host/transport" } {
    const timeSignature: [number, number] = [
      transport.timeSignature[0],
      transport.timeSignature[1],
    ];
    return {
      type: "host/transport",
      isPlaying: transport.isPlaying,
      isRecording: transport.isRecording,
      isLooping: transport.isLooping,
      isMetronomeEnabled: false,
      position: this.buildTimePosition(transport.position, transport.bpm, timeSignature),
      bpm: transport.bpm,
      timeSignature: {
        numerator: transport.timeSignature[0],
        denominator: transport.timeSignature[1],
      },
    };
  }

  private buildTimePosition(
    positionPpqn: number,
    bpm: number,
    timeSignature: [number, number],
  ): TimePosition {
    const bbt = ppqnToBarsBeatsTicks(positionPpqn, timeSignature, DEFAULT_PPQN);
    const seconds = ppqnToSeconds(positionPpqn, bpm, DEFAULT_PPQN);
    return {
      bars: bbt.bars,
      beats: bbt.beats,
      ticks: bbt.ticks,
      seconds: Math.round(seconds * 1_000_000) / 1_000_000,
    };
  }

  private buildTracksMessage(state: ProjectState): HostMessage & { type: "host/tracks" } {
    return {
      type: "host/tracks",
      tracks: state.tracks.map((track) =>
        this.convertTrack(track, state.tracks, state.regions, state.automationLanes, state.automationPoints),
      ),
    };
  }

  private buildNotesMessage(state: ProjectState): HostMessage & { type: "host/notes" } {
    return {
      type: "host/notes",
      notes: state.notes.map((note) => this.convertNote(note)),
    };
  }

  private convertTrack(
    track: EngineTrackState,
    tracks: EngineTrackState[],
    regions: EngineRegionState[],
    automationLanes: EngineAutomationLaneState[],
    automationPoints: EngineAutomationPointState[],
  ): ViewTrackState {
    const lanes = automationLanes.filter((lane) => lane.trackId === track.id);
    const trackNameById = new Map(tracks.map((t) => [t.id, t.name]));
    return {
      id: track.id,
      name: track.name,
      color: track.color ?? defaultTrackColor(track.index),
      type: track.type,
      muted: track.mute,
      soloed: track.solo,
      armed: track.arm,
      volume: dbToLinear(track.volumeDb),
      pan: track.pan,
      height: DEFAULT_TRACK_HEIGHT + lanes.length * AUTOMATION_LANE_HEIGHT,
      inserts: track.inserts.map((insert) => ({
        id: insert.id,
        name: insert.name,
        type: insert.type,
        enabled: insert.enabled,
        index: insert.index,
      })),
      regions: regions
        .filter((region) => region.trackId === track.id)
        .map((region) => this.convertRegion(region)),
      automationLanes: lanes.map((lane) => ({
        id: lane.id,
        trackId: lane.trackId,
        target: lane.target,
        points: automationPoints.filter((point) => point.laneId === lane.id),
      })),
      outputTrackId: track.outputTrackId ?? null,
      sends: track.sends.map((send) => ({
        id: send.id,
        targetTrackId: send.targetTrackId,
        targetName: trackNameById.get(send.targetTrackId) ?? send.targetTrackId,
        amount: send.amount,
      })),
    };
  }

  private convertRegion(region: EngineRegionState): ViewRegionState {
    return {
      id: region.id,
      start: region.position,
      duration: region.duration,
      name: region.name,
      color: regionColor(region.hue),
    };
  }

  private convertNote(note: EngineNoteState): ViewNoteState {
    return {
      id: note.id,
      regionId: note.regionId,
      start: note.position,
      duration: note.duration,
      pitch: note.pitch,
      velocity: note.velocity,
    };
  }
}

function buildBrowserRoot(devices: DeviceListItem[]): BrowserNode {
  const makeDeviceNode = (device: DeviceListItem): BrowserNode => ({
    id: `dev-${device.id}`,
    name: device.name,
    type: "device",
    device,
  });

  return {
    id: "root",
    name: "Browser",
    type: "folder",
    children: [
      {
        id: "devices",
        name: "Devices",
        type: "folder",
        children: [
          {
            id: "devices-instruments",
            name: "Instruments",
            type: "folder",
            children: devices
              .filter((device) => device.category === "instrument")
              .map(makeDeviceNode),
          },
          {
            id: "devices-audio-effects",
            name: "Audio Effects",
            type: "folder",
            children: devices
              .filter((device) => device.category === "audio-effect")
              .map(makeDeviceNode),
          },
          {
            id: "devices-midi-effects",
            name: "MIDI Effects",
            type: "folder",
            children: devices
              .filter((device) => device.category === "midi-effect")
              .map(makeDeviceNode),
          },
        ],
      },
      {
        id: "workspace",
        name: "Workspace Samples",
        type: "folder",
        children: [],
      },
      {
        id: "project",
        name: "Project Samples",
        type: "folder",
        children: [],
      },
    ],
  };
}

function selectionEquals(a: SelectionState, b: SelectionState): boolean {
  if (a.trackId !== b.trackId) return false;
  if (a.regionId !== b.regionId) return false;
  const aIds = a.noteIds ?? [];
  const bIds = b.noteIds ?? [];
  if (aIds.length !== bIds.length) return false;
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) return false;
  }
  return true;
}
