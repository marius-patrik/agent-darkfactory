import { PrimitiveType } from "@opendaw/lib-box";
import { WavFile } from "@opendaw/lib-dsp";
import { Option, UUID } from "@opendaw/lib-std";
import {
  type AnyRegionBoxAdapter,
  AudioRegionBoxAdapter,
  type AudioUnitBoxAdapter,
  AudioUnitFactory,
  Devices,
  type ExportConfiguration,
  type InstrumentBox,
  InstrumentFactories,
  type NoteEventBoxAdapter,
  NoteEventCollectionBoxAdapter,
  NoteRegionBoxAdapter,
  RegionAdapters,
  RegionEditing,
  TrackType as SdkTrackType,
  type TrackBoxAdapter,
} from "@opendaw/studio-adapters";
import {
  AudioFileBox,
  AudioRegionBox,
  type AudioUnitBox,
  NoteEventBox,
  NoteRegionBox,
  TrackBox,
} from "@opendaw/studio-boxes";
import {
  AudioOfflineRenderer,
  type AudioWorklets,
  CaptureAudio,
  CaptureMidi,
  EffectFactories,
  type EffectFactory,
  GlobalSampleLoaderManager,
  GlobalSoundfontLoaderManager,
  MidiDevices,
  Project,
  type ProjectEnv,
  SampleService,
  SoundfontService,
  Workers,
} from "@opendaw/studio-core";
import { SampleStorage, SoundfontStorage } from "@opendaw/studio-core";
import { DEFAULT_AUTOMATION_VALUE } from "../shared/automation.js";
import type {
  AutomationLaneState,
  AutomationPointState,
  AutomationTarget,
  TrackType as ApiTrackType,
  DeviceListItem,
  DeviceParameterDescriptor,
  ExportFormat,
  ExportRenderResult,
  InsertState,
  NoteState,
  PeaksResultPayload,
  ProjectState,
  RegionState,
  SendState,
  TrackState,
} from "../shared/protocol.js";

export interface BootEnv extends ProjectEnv {
  audioContext: AudioContext;
  audioWorklets: AudioWorklets;
}

export interface ProjectControllerOptions {
  bootEnv: BootEnv;
  projectId: string;
  onStateChange?: (state: ProjectState) => void;
  onTransportPosition?: (position: number) => void;
}

function log(action: string, message: string) {
  console.log(`[VSDAW engine] ${action}: ${message}`);
}

function warn(action: string, message: string) {
  console.warn(`[VSDAW engine] ${action}: ${message}`);
}

export class ProjectController {
  readonly bootEnv: BootEnv;
  readonly projectId: string;
  private project: Project | null = null;
  private subscriptions: Array<() => void> = [];
  private trackNames = new Map<string, string>();
  private trackColors = new Map<string, string>();
  private trackTypes = new Map<string, ApiTrackType>();
  private trackOutputs = new Map<string, string | null>();
  private trackSends = new Map<string, SendState[]>();
  private takeRegions = new Map<string, AnyRegionBoxAdapter[]>();
  private automationLanes = new Map<string, AutomationLaneState>();
  private automationPoints = new Map<string, AutomationPointState>();
  private lastAutomationValues = new Map<string, number>();

  constructor(options: ProjectControllerOptions) {
    this.bootEnv = options.bootEnv;
    this.projectId = options.projectId;
    if (options.onStateChange) {
      this.onStateChange = options.onStateChange;
    }
    if (options.onTransportPosition) {
      this.onTransportPosition = options.onTransportPosition;
    }
  }

  private onStateChange?: (state: ProjectState) => void;
  private onTransportPosition?: (position: number) => void;

  private assertProject(): Project {
    if (this.project === null) {
      throw new Error("No project is currently open");
    }
    return this.project;
  }

  private get boxGraph() {
    return this.assertProject().boxGraph;
  }

  private get api() {
    return this.assertProject().api;
  }

  private get engine() {
    return this.assertProject().engine;
  }

  private get rootAdapter() {
    return this.assertProject().rootBoxAdapter;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  newProject(defaultBpm = 120, timeSignature: [number, number] = [4, 4]) {
    try {
      this.closeProject();
      log("project", `creating new project bpm=${defaultBpm}`);
      const env: ProjectEnv = {
        audioContext: this.bootEnv.audioContext,
        audioWorklets: this.bootEnv.audioWorklets,
        sampleManager: this.bootEnv.sampleManager,
        soundfontManager: this.bootEnv.soundfontManager,
        sampleService: this.bootEnv.sampleService,
        soundfontService: this.bootEnv.soundfontService,
      };
      this.project = Project.new(env);
      this.api.setBpm(defaultBpm);
      this.setTimeSignature(timeSignature[0], timeSignature[1]);
      this.project.startAudioWorklet();
      this.attachTransportObservers();
      this.broadcastState();
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      log("project", `newProject failed: ${text}`);
      throw error;
    }
  }

  loadProject(data: ArrayBufferLike) {
    try {
      this.closeProject();
      log("project", "loading project");
      const env: ProjectEnv = {
        audioContext: this.bootEnv.audioContext,
        audioWorklets: this.bootEnv.audioWorklets,
        sampleManager: this.bootEnv.sampleManager,
        soundfontManager: this.bootEnv.soundfontManager,
        sampleService: this.bootEnv.sampleService,
        soundfontService: this.bootEnv.soundfontService,
      };
      this.project = Project.load(env, data as ArrayBuffer);
      this.project.startAudioWorklet();
      this.attachTransportObservers();
      this.broadcastState();
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      log("project", `loadProject failed: ${text}`);
      throw error;
    }
  }

  serializeProject(): ArrayBufferLike {
    return this.assertProject().toArrayBuffer();
  }

  closeProject() {
    log("project", "closing project");
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
    if (this.project) {
      try {
        this.project.engine.stop(true);
      } catch {
        // ignore
      }
      try {
        this.project.terminate();
      } catch {
        // ignore
      }
      this.project = null;
    }
    this.trackNames.clear();
    this.trackColors.clear();
    this.trackTypes.clear();
    this.trackOutputs.clear();
    this.trackSends.clear();
    this.takeRegions.clear();
    this.automationLanes.clear();
    this.automationPoints.clear();
    this.lastAutomationValues.clear();
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  play() {
    this.engine.play();
    this.broadcastTransportState();
  }

  pause() {
    this.engine.stop(false);
    this.broadcastTransportState();
  }

  stop() {
    this.engine.stop(true);
    this.broadcastTransportState();
  }

  record() {
    this.assertProject().startRecording(false);
    this.broadcastTransportState();
  }

  seek(position: number, unit: "ppqn" | "seconds" | "bars" = "ppqn") {
    let ppqn = position;
    const bpm = this.engine.bpm.getValue();
    if (unit === "seconds") {
      ppqn = (position * bpm * 960) / 60;
    } else if (unit === "bars") {
      ppqn = position * 4 * 960;
    }
    this.engine.setPosition(Math.max(0, Math.round(ppqn)));
    this.broadcastTransportPosition();
  }

  setLoop(enabled: boolean, start?: number, end?: number) {
    const loop = this.assertProject().timelineBox.loopArea;
    this.boxGraph.beginTransaction();
    loop.enabled.setValue(enabled);
    if (start !== undefined) loop.from.setValue(start);
    if (end !== undefined) loop.to.setValue(end);
    this.boxGraph.endTransaction();
    this.broadcastTransportState();
  }

  setTempo(bpm: number) {
    this.api.setBpm(bpm);
    this.broadcastTransportState();
  }

  setTimeSignature(numerator: number, denominator: number) {
    const timeline = this.assertProject().timelineBox;
    this.boxGraph.beginTransaction();
    timeline.signature.nominator.setValue(numerator);
    timeline.signature.denominator.setValue(denominator);
    this.boxGraph.endTransaction();
    this.broadcastTransportState();
  }

  // ---------------------------------------------------------------------------
  // Tracks
  // ---------------------------------------------------------------------------

  createTrack(type: ApiTrackType, name?: string, index?: number, color?: string) {
    if (type === "master") {
      throw new Error(
        "Track type 'master' is reserved for the primary output bus and cannot be created",
      );
    }

    const project = this.assertProject();
    let audioUnit: AudioUnitBox;

    if (type === "midi") {
      const product = this.api.createInstrument(InstrumentFactories.Tape, {
        name: name ?? "MIDI Track",
      });
      audioUnit = product.audioUnitBox;
    } else if (type === "audio") {
      const capture = AudioUnitFactory.trackTypeToCapture(project.boxGraph, SdkTrackType.Audio);
      audioUnit = AudioUnitFactory.create(project.skeleton, "instrument" as any, capture, index);
      this.api.createAudioTrack(audioUnit, 0);
    } else {
      // bus
      audioUnit = AudioUnitFactory.create(project.skeleton, "bus" as any, Option.None, index);
      this.api.createAudioTrack(audioUnit, 0);
    }

    const id = UUID.toString(audioUnit.address.uuid);
    this.trackNames.set(id, name ?? `${type} track`);
    this.trackTypes.set(id, type);
    if (color) this.trackColors.set(id, color);

    // Ensure the displayed label stays in sync with our name map.
    try {
      const adapter = this.resolveAudioUnit(id);
      adapter.input.label = this.trackNames.get(id) ?? id;
    } catch {
      // ignore
    }

    if (index !== undefined) {
      const adapter = this.resolveAudioUnit(id);
      adapter.move(index - adapter.indexField.getValue());
    }

    this.broadcastState();
    return id;
  }

  deleteTrack(trackId: string) {
    const unit = this.resolveAudioUnit(trackId);
    this.api.deleteAudioUnit(unit.box);
    this.trackNames.delete(trackId);
    this.trackColors.delete(trackId);
    this.trackTypes.delete(trackId);
    this.broadcastState();
  }

  reorderTrack(trackId: string, newIndex: number) {
    const unit = this.resolveAudioUnit(trackId);
    const delta = newIndex - unit.indexField.getValue();
    if (delta !== 0) {
      unit.move(delta);
    }
    this.broadcastState();
  }

  setTrackName(trackId: string, name: string) {
    this.trackNames.set(trackId, name);
    const unit = this.resolveAudioUnit(trackId);
    try {
      unit.input.label = name;
    } catch {
      // some inputs do not support label writes
    }
    this.broadcastState();
  }

  setTrackColor(trackId: string, color: string) {
    this.trackColors.set(trackId, color);
    this.broadcastState();
  }

  setTrackVolumeDb(trackId: string, volumeDb: number) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.volume.setValue(volumeDb);
    this.broadcastState();
  }

  setTrackPan(trackId: string, pan: number) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.panning.setValue(pan);
    this.broadcastState();
  }

  setTrackMute(trackId: string, mute: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.mute.setValue(mute);
    this.broadcastState();
  }

  setTrackSolo(trackId: string, solo: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    unit.namedParameter.solo.setValue(solo);
    this.broadcastState();
  }

  setTrackArm(trackId: string, arm: boolean) {
    const unit = this.resolveAudioUnit(trackId);
    const devices = this.assertProject().captureDevices;
    const capture = devices.get(unit.box.address.uuid);
    if (capture.nonEmpty()) {
      capture.unwrap().armed.setValue(arm);
    }
    this.broadcastState();
  }

  setTrackOutput(trackId: string, outputTrackId: string | null) {
    this.trackOutputs.set(trackId, outputTrackId);
    this.broadcastState();
  }

  addTrackSend(trackId: string, targetTrackId: string, amount = 0) {
    const sends = this.trackSends.get(trackId) ?? [];
    const id = `${trackId}->${targetTrackId}-${Date.now()}`;
    sends.push({ id, targetTrackId, amount });
    this.trackSends.set(trackId, sends);
    this.broadcastState();
    return id;
  }

  removeTrackSend(sendId: string) {
    for (const [trackId, sends] of this.trackSends.entries()) {
      const next = sends.filter((s) => s.id !== sendId);
      if (next.length !== sends.length) {
        this.trackSends.set(trackId, next);
        this.broadcastState();
        return;
      }
    }
  }

  setTrackSendAmount(sendId: string, amount: number) {
    for (const sends of this.trackSends.values()) {
      const send = sends.find((s) => s.id === sendId);
      if (send) {
        send.amount = amount;
        this.broadcastState();
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Audio regions
  // ---------------------------------------------------------------------------

  async importAudioFile(
    arrayBuffer: ArrayBuffer,
    name?: string,
    bpm?: number,
  ): Promise<{ sampleId: string; sample: any }> {
    const sample = await this.bootEnv.sampleService.importFile({
      arrayBuffer,
      name,
      bpm,
    });
    return { sampleId: sample.uuid, sample };
  }

  createAudioRegion(
    trackId: string,
    sample: {
      uuid: string;
      name: string;
      duration: number;
      bpm: number;
      sample_rate?: number;
      origin?: "recording" | "openDAW" | "import";
    },
    position: number,
    duration?: number,
    offset?: number,
    name?: string,
  ): string {
    const track = this.resolveMainTrack(trackId);
    const project = this.assertProject();

    if (!sample.uuid || !sample.name || sample.duration == null || sample.bpm == null) {
      throw new Error("Invalid sample metadata: uuid, name, duration and bpm are required");
    }

    const sampleRate = sample.sample_rate ?? this.bootEnv.audioContext.sampleRate;
    const fullSample = {
      ...sample,
      sample_rate: sampleRate,
      origin: sample.origin ?? "import",
    };

    const audioFileBox = AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid));
    const regionBox = this.api.createNotStretchedRegion({
      boxGraph: project.boxGraph,
      targetTrack: track.box,
      audioFileBox,
      sample: fullSample as any,
      position,
      duration,
      name: name ?? sample.name,
    });
    const adapter = project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter);

    if (offset !== undefined && offset !== 0) {
      try {
        adapter.waveformOffset.setValue(offset);
      } catch (error: unknown) {
        warn(
          "region",
          `could not apply offset: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.broadcastState();
    return UUID.toString(adapter.uuid);
  }

  createMidiRegion(trackId: string, position: number, duration: number, name?: string): string {
    const track = this.resolveMainTrack(trackId);
    const regionBox = this.api.createNoteRegion({
      trackBox: track.box,
      position,
      duration,
      name: name ?? "MIDI",
    });
    const adapter = this.assertProject().boxAdapters.adapterFor(regionBox, NoteRegionBoxAdapter);
    this.broadcastState();
    return UUID.toString(adapter.uuid);
  }

  moveRegion(regionId: string, position: number, trackId?: string) {
    const region = this.resolveRegion(regionId);
    this.boxGraph.beginTransaction();
    region.position = position;
    if (trackId) {
      const track = this.resolveMainTrack(trackId);
      region.box.regions.refer(track.box.regions);
    }
    this.boxGraph.endTransaction();
    this.broadcastState();
  }

  resizeRegion(regionId: string, duration: number) {
    const region = this.resolveRegion(regionId);
    region.duration = duration;
    this.broadcastState();
  }

  splitRegion(regionId: string, position: number): string[] {
    const region = this.resolveRegion(regionId);
    this.boxGraph.beginTransaction();
    const split = RegionEditing.cut(region, position, false);
    this.boxGraph.endTransaction();
    if (split.isEmpty()) {
      return [regionId];
    }
    this.broadcastState();
    return [regionId, UUID.toString(split.unwrap().uuid)];
  }

  setFadeIn(regionId: string, value: number) {
    const region = this.resolveAudioRegion(regionId);
    region.fading.inField.setValue(value);
    this.broadcastState();
  }

  setFadeOut(regionId: string, value: number) {
    const region = this.resolveAudioRegion(regionId);
    region.fading.outField.setValue(value);
    this.broadcastState();
  }

  deleteRegion(regionId: string) {
    const region = this.resolveRegion(regionId);
    region.box.delete();
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // MIDI notes
  // ---------------------------------------------------------------------------

  addNote(
    regionId: string,
    position: number,
    duration: number,
    pitch: number,
    velocity: number,
  ): string {
    const region = this.resolveNoteRegion(regionId);
    const collection = region.optCollection.unwrap("Region has no note collection");
    const note = collection.createEvent({
      position,
      duration,
      pitch,
      velocity,
      cent: 0,
      chance: 100,
      playCount: 1,
    });
    this.broadcastState();
    return UUID.toString(note.uuid);
  }

  moveNote(noteId: string, position?: number, pitch?: number) {
    const note = this.resolveNote(noteId);
    this.boxGraph.beginTransaction();
    if (position !== undefined) note.box.position.setValue(position);
    if (pitch !== undefined) note.box.pitch.setValue(pitch);
    this.boxGraph.endTransaction();
    this.broadcastState();
  }

  resizeNote(noteId: string, duration: number) {
    const note = this.resolveNote(noteId);
    note.box.duration.setValue(duration);
    this.broadcastState();
  }

  deleteNote(noteId: string) {
    const note = this.resolveNote(noteId);
    note.box.delete();
    this.broadcastState();
  }

  setNoteVelocity(noteId: string, velocity: number) {
    const note = this.resolveNote(noteId);
    note.box.velocity.setValue(velocity);
    this.broadcastState();
  }

  handleMidiInput(deviceId: string, data: Uint8Array, timestamp: number) {
    if (data.length < 1) return;

    // Forward the raw MIDI event through the SDK's software MIDI input so that
    // armed captures (audio-unit inputs) and the engine's own routing pick it
    // up with correct latency/timing. This replaces the previous direct
    // engine.noteSignal() call, which passed an incorrect NoteSignal shape.
    try {
      const event = new MIDIMessageEvent("midimessage", {
        data: new Uint8Array(data),
      } as MIDIMessageEventInit);
      MidiDevices.softwareMIDIInput.dispatchEvent(event);
    } catch (error: unknown) {
      warn(
        "midi",
        `failed to dispatch MIDI input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  async startRecording(trackIds?: string[], countIn = false) {
    const project = this.assertProject();
    const devices = project.captureDevices;

    if (trackIds && trackIds.length > 0) {
      for (const trackId of trackIds) {
        const unit = this.resolveAudioUnit(trackId);
        const capture = devices.get(unit.box.address.uuid);
        if (capture.nonEmpty()) {
          capture.unwrap().armed.setValue(true);
        }
      }
    }

    log("recording", `start countIn=${countIn}`);
    project.startRecording(countIn);
    this.broadcastTransportState();
  }

  stopRecording() {
    const project = this.assertProject();
    log("recording", "stop");
    project.stopRecording();

    // Audio captures write recorded regions to themselves; gather them as takes.
    this.takeRegions.clear();
    for (const capture of project.captureDevices.allCaptures()) {
      if (capture instanceof CaptureAudio) {
        const regions = capture.recordedRegions();
        if (regions.length > 0) {
          const unitId = UUID.toString(capture.audioUnitBox.address.uuid);
          const adapters = regions.map((box) => RegionAdapters.for(project.boxAdapters, box));
          this.takeRegions.set(unitId, adapters);
        }
      }
    }

    // MIDI captures keep captured notes internally; commit them to a note region.
    try {
      project.commitMidiCapture();
    } catch (error: unknown) {
      warn(
        "recording",
        `commitMidiCapture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.broadcastTransportState();
  }

  compTakes(takeRegionIds: string[], activeRegionId: string) {
    const activeTakes = new Set(takeRegionIds);
    for (const id of takeRegionIds) {
      const region = this.resolveRegion(id);
      if (region.box instanceof AudioRegionBox || region.box instanceof NoteRegionBox) {
        region.box.mute.setValue(id !== activeRegionId);
      }
    }
    // Mute any other recorded takes for the same audio units that are not in
    // the active comp set.
    for (const regions of this.takeRegions.values()) {
      for (const region of regions) {
        const id = UUID.toString(region.uuid);
        if (!activeTakes.has(id)) {
          if (region.box instanceof AudioRegionBox || region.box instanceof NoteRegionBox) {
            region.box.mute.setValue(true);
          }
        }
      }
    }
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Automation lanes
  // ---------------------------------------------------------------------------

  addAutomationLane(trackId: string, target: AutomationTarget): string {
    this.resolveAudioUnit(trackId);
    const laneId = UUID.toString(UUID.generate());
    this.automationLanes.set(laneId, { id: laneId, trackId, target });
    this.broadcastState();
    return laneId;
  }

  removeAutomationLane(laneId: string) {
    const lane = this.automationLanes.get(laneId);
    if (!lane) {
      throw new Error(`Automation lane not found: ${laneId}`);
    }
    this.automationLanes.delete(laneId);
    for (const [id, point] of this.automationPoints) {
      if (point.laneId === laneId) {
        this.automationPoints.delete(id);
      }
    }
    this.lastAutomationValues.delete(laneId);
    this.broadcastState();
  }

  addAutomationPoint(laneId: string, position: number, value: number): string {
    const lane = this.automationLanes.get(laneId);
    if (!lane) {
      throw new Error(`Automation lane not found: ${laneId}`);
    }
    const pointId = UUID.toString(UUID.generate());
    this.automationPoints.set(pointId, {
      id: pointId,
      laneId,
      position,
      value: Math.max(0, Math.min(1, value)),
    });
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
    return pointId;
  }

  moveAutomationPoint(pointId: string, position?: number, value?: number) {
    const point = this.automationPoints.get(pointId);
    if (!point) {
      throw new Error(`Automation point not found: ${pointId}`);
    }
    if (position !== undefined) point.position = position;
    if (value !== undefined) point.value = Math.max(0, Math.min(1, value));
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
  }

  deleteAutomationPoint(pointId: string) {
    const point = this.automationPoints.get(pointId);
    if (!point) {
      throw new Error(`Automation point not found: ${pointId}`);
    }
    this.automationPoints.delete(pointId);
    this.applyAutomationAtCurrentPosition();
    this.broadcastState();
  }

  private getAutomationPointsForLane(laneId: string): AutomationPointState[] {
    return Array.from(this.automationPoints.values())
      .filter((point) => point.laneId === laneId)
      .sort((a, b) => a.position - b.position);
  }

  private interpolateAutomationValue(laneId: string, position: number): number {
    const points = this.getAutomationPointsForLane(laneId);
    if (points.length === 0) {
      return DEFAULT_AUTOMATION_VALUE;
    }
    if (position <= points[0].position) {
      return points[0].value;
    }
    if (position >= points[points.length - 1].position) {
      return points[points.length - 1].value;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (position >= a.position && position <= b.position) {
        const t =
          b.position === a.position ? 0 : (position - a.position) / (b.position - a.position);
        return a.value + (b.value - a.value) * t;
      }
    }
    return points[points.length - 1].value;
  }

  private applyAutomationAtCurrentPosition() {
    const position = this.engine.position.getValue() / 960;
    this.applyAutomation(position);
  }

  private applyAutomation(position: number) {
    for (const lane of this.automationLanes.values()) {
      const value = this.interpolateAutomationValue(lane.id, position);
      const last = this.lastAutomationValues.get(lane.id);
      if (last !== undefined && Math.abs(last - value) < 0.001) {
        continue;
      }
      this.lastAutomationValues.set(lane.id, value);
      this.applyAutomationValue(lane, value);
    }
  }

  private applyAutomationValue(lane: AutomationLaneState, value: number) {
    try {
      switch (lane.target.type) {
        case "volume": {
          const db = value <= 0 ? -120 : 20 * Math.log10(value);
          this.setTrackVolumeDb(lane.target.trackId, db);
          break;
        }
        case "pan": {
          this.setTrackPan(lane.target.trackId, value * 2 - 1);
          break;
        }
        case "device": {
          const deviceId = lane.target.deviceId;
          const parameter = lane.target.parameter;
          if (!deviceId || !parameter) return;
          const params = this.getDeviceParameters(deviceId);
          const param = params.find((p) => p.name === parameter);
          if (!param) return;
          if (param.type === "boolean") {
            this.setDeviceParameter(deviceId, parameter, value >= 0.5);
          } else {
            const min = typeof param.min === "number" ? param.min : 0;
            const max = typeof param.max === "number" ? param.max : 1;
            this.setDeviceParameter(deviceId, parameter, min + value * (max - min));
          }
          break;
        }
      }
    } catch (error: unknown) {
      warn("automation", error instanceof Error ? error.message : String(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Effects / inserts
  // ---------------------------------------------------------------------------

  createDevice(
    slot: "instrument" | "audio-effect" | "midi-effect",
    factoryName: string,
    trackId?: string,
    insertIndex?: number,
  ): string {
    const project = this.assertProject();

    if (slot === "instrument") {
      const instrumentFactory =
        (InstrumentFactories.Named as any)[factoryName] ?? InstrumentFactories.Tape;

      if (trackId) {
        const unit = this.resolveAudioUnit(trackId);
        const input = unit.input.adapter().unwrapOrNull();
        if (input && Devices.isInstrument(input)) {
          const result = this.api.replaceMIDIInstrument(
            input.box as InstrumentBox,
            instrumentFactory,
          );
          if (result.isSuccess()) {
            this.broadcastState();
            return UUID.toString(result.result().address.uuid);
          }
          throw new Error(result.failureReason());
        }
        throw new Error(`Track '${trackId}' does not host a replaceable instrument`);
      }

      const product = this.api.createInstrument(instrumentFactory);
      this.broadcastState();
      return UUID.toString(product.instrumentBox.address.uuid);
    }

    const factory = this.resolveEffectFactory(factoryName);
    const unit = trackId
      ? this.resolveAudioUnit(trackId)
      : this.rootAdapter.audioUnits.adapters()[0];
    if (!unit) {
      throw new Error("No target track available for effect");
    }
    const field = slot === "midi-effect" ? unit.midiEffectsField : unit.audioEffectsField;
    const effectBox = this.api.insertEffect(field, factory, insertIndex);
    this.broadcastState();
    return UUID.toString(effectBox.address.uuid);
  }

  deleteDevice(deviceId: string) {
    const device = this.resolveDevice(deviceId);
    device.box.delete();
    this.broadcastState();
  }

  moveDevice(deviceId: string, newIndex: number) {
    const device = this.resolveDevice(deviceId);
    const host = device.deviceHost();
    const collection =
      device.type === "midi-effect"
        ? host.midiEffects
        : device.type === "audio-effect"
          ? host.audioEffects
          : null;
    if (collection) {
      collection.move(device as any, newIndex - device.indexField.getValue());
    }
    this.broadcastState();
  }

  setDeviceParameter(deviceId: string, parameter: string, value: number | boolean) {
    const device = this.resolveDevice(deviceId);
    const params = (device as any).namedParameter;
    if (params && parameter in params) {
      params[parameter].setValue(value as any);
    } else {
      // Try direct field access for devices that expose parameters as fields.
      const field = (device.box as any)[parameter];
      if (field && typeof field.setValue === "function") {
        field.setValue(value);
      } else {
        throw new Error(`Parameter '${parameter}' not found on device ${deviceId}`);
      }
    }
    this.broadcastState();
  }

  listDevices(): DeviceListItem[] {
    const instruments = Object.entries(InstrumentFactories.Named).map(([id, factory]) => ({
      id,
      name: (factory as any).defaultName ?? id,
      category: "instrument" as const,
    }));
    const audioEffects = Object.entries(EffectFactories.AudioNamed).map(([id, factory]) => ({
      id,
      name: (factory as any).defaultName ?? id,
      category: "audio-effect" as const,
    }));
    const midiEffects = Object.entries(EffectFactories.MidiNamed).map(([id, factory]) => ({
      id,
      name: (factory as any).defaultName ?? id,
      category: "midi-effect" as const,
    }));
    return [...instruments, ...audioEffects, ...midiEffects];
  }

  getDeviceParameters(deviceId: string): DeviceParameterDescriptor[] {
    const device = this.resolveDevice(deviceId);
    const params = (device as any).namedParameter as Record<
      string,
      {
        name: string;
        type: PrimitiveType;
        getValue: () => number | boolean;
        valueMapping?: { y: (x: number) => number };
      }
    >;
    if (!params) {
      return [];
    }

    return Object.entries(params).map(([key, param]) => {
      const value = param.getValue();
      const isBoolean = param.type === PrimitiveType.Boolean;
      if (isBoolean) {
        return {
          name: param.name ?? key,
          value,
          min: false,
          max: true,
          type: "boolean" as const,
        };
      }
      let min = 0;
      let max = 1;
      try {
        if (param.valueMapping) {
          min = param.valueMapping.y(0);
          max = param.valueMapping.y(1);
        }
      } catch {
        // Keep defaults if the mapping cannot be sampled.
      }
      return {
        name: param.name ?? key,
        value,
        min,
        max,
        type: "number" as const,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Peaks
  // ---------------------------------------------------------------------------

  async getPeaks(sampleId: string, width: number, channel = 0): Promise<PeaksResultPayload> {
    const loader = this.bootEnv.sampleManager.getOrCreate(UUID.parse(sampleId));
    const state = loader.state;
    if (state.type !== "loaded") {
      await new Promise<void>((resolve, reject) => {
        const sub = loader.subscribe((s) => {
          if (s.type === "loaded") {
            sub.terminate();
            resolve();
          } else if (s.type === "error") {
            sub.terminate();
            reject(new Error(s.reason));
          }
        });
      });
    }
    const audioData = loader.data.unwrap("Sample data not loaded");
    const peaks = generatePeaks(audioData.frames, width, channel);
    return {
      sampleId,
      channel,
      peaks,
      sampleRate: audioData.sampleRate,
      numberOfChannels: audioData.numberOfChannels,
      numberOfFrames: audioData.numberOfFrames,
    };
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async renderExport(
    format: ExportFormat,
    start?: number,
    end?: number,
    fileName?: string,
    stems = false,
  ): Promise<ExportRenderResult> {
    const project = this.assertProject();
    const sampleRate = this.bootEnv.audioContext.sampleRate;
    const range: ExportConfiguration["range"] =
      start !== undefined && end !== undefined ? { start, end } : "full";

    let exportConfiguration: ExportConfiguration;
    if (stems) {
      const stemMap: Record<string, any> = {};
      for (const unit of this.rootAdapter.audioUnits.adapters()) {
        stemMap[UUID.toString(unit.uuid)] = {
          includeAudioEffects: true,
          includeSends: true,
          useInstrumentOutput: false,
          fileName: `${this.trackNames.get(UUID.toString(unit.uuid)) ?? "stem"}.wav`,
        };
      }
      exportConfiguration = { range, stems: stemMap };
    } else {
      const masterId = UUID.toString(project.primaryAudioBusBox.address.uuid);
      exportConfiguration = {
        range,
        stems: {
          [masterId]: {
            includeAudioEffects: true,
            includeSends: true,
            useInstrumentOutput: false,
            skipChannelStrip: false,
            fileName: fileName ?? "render.wav",
          },
        },
      };
    }

    log("export", `rendering ${stems ? "stems" : "master"} at ${sampleRate}Hz`);
    try {
      const audioBuffer = await AudioOfflineRenderer.start(
        project,
        Option.wrap(exportConfiguration),
        () => {},
        undefined,
        sampleRate,
      );

      if (format === "wav") {
        const arrayBuffer = WavFile.encodeFloats(audioBuffer);
        return {
          format,
          data: arrayBufferToBase64(arrayBuffer),
          fileName: fileName ?? "render.wav",
        };
      }

      // FLAC/OGG/MP3: encode via the deprecated renderer's AudioBuffer result.
      // A real implementation would pipe through ffmpeg.wasm or a browser encoder.
      // For now we fall back to WAV and report the fallback.
      const arrayBuffer = WavFile.encodeFloats(audioBuffer);
      return {
        format,
        data: arrayBufferToBase64(arrayBuffer),
        fileName: fileName ?? `render.${format}`,
        message: `${format.toUpperCase()} encoding not yet implemented; returned WAV data instead.`,
      };
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      log("export", `render failed: ${text}`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // State snapshot
  // ---------------------------------------------------------------------------

  getState(): ProjectState {
    const project = this.assertProject();
    const timeline = project.timelineBox;
    const loop = timeline.loopArea;
    const devices = project.captureDevices;
    const transport: ProjectState["transport"] = {
      isPlaying: this.engine.isPlaying.getValue(),
      isRecording: this.engine.isRecording.getValue(),
      isLooping: loop.enabled.getValue(),
      position: this.engine.position.getValue(),
      bpm: this.engine.bpm.getValue(),
      timeSignature: [
        timeline.signature.nominator.getValue(),
        timeline.signature.denominator.getValue(),
      ],
      loopStart: loop.from.getValue(),
      loopEnd: loop.to.getValue(),
    };

    const tracks: TrackState[] = [];
    const regions: RegionState[] = [];
    const notes: NoteState[] = [];

    for (const unit of this.rootAdapter.audioUnits.adapters()) {
      const id = UUID.toString(unit.uuid);
      const type: ApiTrackType = this.trackTypes.get(id) ?? (unit.isBus ? "bus" : "audio");
      const inserts: InsertState[] = [];

      // The input slot may host an instrument (MIDI tracks) or an audio source.
      const input = unit.input.adapter().unwrapOrNull();
      if (input) {
        inserts.push({
          id: UUID.toString(input.uuid),
          name: input.labelField.getValue(),
          type: Devices.isInstrument(input) ? "instrument" : "audio-effect",
          enabled: input.enabledField.getValue(),
          index: -1,
        });
      }

      for (const fx of unit.audioEffects.adapters()) {
        inserts.push({
          id: UUID.toString(fx.uuid),
          name: fx.labelField.getValue(),
          type: "audio-effect",
          enabled: fx.enabledField.getValue(),
          index: fx.indexField.getValue(),
        });
      }
      for (const fx of unit.midiEffects.adapters()) {
        inserts.push({
          id: UUID.toString(fx.uuid),
          name: fx.labelField.getValue(),
          type: "midi-effect",
          enabled: fx.enabledField.getValue(),
          index: fx.indexField.getValue(),
        });
      }

      const capture = devices.get(unit.uuid);
      tracks.push({
        id,
        type,
        name: this.trackNames.get(id) ?? unit.label,
        color: this.trackColors.get(id),
        index: unit.indexField.getValue(),
        volumeDb: unit.namedParameter.volume.getValue(),
        pan: unit.namedParameter.panning.getValue(),
        mute: unit.namedParameter.mute.getValue(),
        solo: unit.namedParameter.solo.getValue(),
        arm: capture.mapOr((c) => c.armed.getValue(), false),
        inserts,
        outputTrackId: this.trackOutputs.get(trackId) ?? null,
        sends: this.trackSends.get(trackId) ?? [],
      });

      for (const track of unit.tracks.values()) {
        for (const region of track.regions.collection.asArray()) {
          const regionId = UUID.toString(region.uuid);
          const base: RegionState = {
            id: regionId,
            trackId: id,
            type: region.isAudioRegion() ? "audio" : "midi",
            position: region.position,
            duration: region.duration,
            name: region.label,
            hue: region.hue,
          };
          if (region.isAudioRegion()) {
            base.fadeIn = region.fading.in;
            base.fadeOut = region.fading.out;
            base.offset = region.offset;
          }
          regions.push(base);

          if (region.isNoteRegion()) {
            const optCollection = region.optCollection;
            if (optCollection.nonEmpty()) {
              for (const note of optCollection.unwrap().events.asArray()) {
                notes.push({
                  id: UUID.toString(note.uuid),
                  regionId,
                  position: note.position,
                  duration: note.duration,
                  pitch: note.pitch,
                  velocity: note.velocity,
                });
              }
            }
          }
        }
      }
    }

    return {
      projectId: this.projectId,
      tracks,
      regions,
      notes,
      automationLanes: Array.from(this.automationLanes.values()),
      automationPoints: Array.from(this.automationPoints.values()),
      transport,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveAudioUnit(trackId: string): AudioUnitBoxAdapter {
    const id = UUID.parse(trackId);
    const unit = this.rootAdapter.audioUnits.getAdapterById(id);
    if (unit.isEmpty()) {
      throw new Error(`Track not found: ${trackId}`);
    }
    return unit.unwrap();
  }

  private resolveMainTrack(trackId: string): TrackBoxAdapter {
    const unit = this.resolveAudioUnit(trackId);
    const type = this.trackTypes.get(UUID.toString(unit.uuid));
    const tracks = unit.tracks.values();
    if (tracks.length === 0) {
      throw new Error(`Track '${trackId}' has no timeline lane`);
    }
    // Prefer the first main track matching the declared unit type.
    const targetType =
      type === "midi"
        ? SdkTrackType.Notes
        : type === "bus"
          ? SdkTrackType.Audio
          : SdkTrackType.Audio;
    return tracks.find((t) => t.type === targetType) ?? tracks[0];
  }

  private resolveRegion(regionId: string): AnyRegionBoxAdapter {
    const id = UUID.parse(regionId);
    for (const unit of this.rootAdapter.audioUnits.adapters()) {
      for (const track of unit.tracks.values()) {
        const region = track.regions.adapters.opt(id);
        if (region.nonEmpty()) {
          return region.unwrap();
        }
      }
    }
    throw new Error(`Region not found: ${regionId}`);
  }

  private resolveAudioRegion(regionId: string): AudioRegionBoxAdapter {
    const region = this.resolveRegion(regionId);
    if (!region.isAudioRegion()) {
      throw new Error(`Region '${regionId}' is not an audio region`);
    }
    return region;
  }

  private resolveNoteRegion(regionId: string): NoteRegionBoxAdapter {
    const region = this.resolveRegion(regionId);
    if (!region.isNoteRegion()) {
      throw new Error(`Region '${regionId}' is not a MIDI region`);
    }
    return region;
  }

  private resolveNote(noteId: string): NoteEventBoxAdapter {
    const id = UUID.parse(noteId);
    for (const unit of this.rootAdapter.audioUnits.adapters()) {
      for (const track of unit.tracks.values()) {
        for (const region of track.regions.collection.asArray()) {
          if (!region.isNoteRegion()) continue;
          const optCollection = region.optCollection;
          if (optCollection.isEmpty()) continue;
          const note = optCollection
            .unwrap()
            .events.asArray()
            .find((n) => UUID.equals(n.uuid, id));
          if (note) return note;
        }
      }
    }
    throw new Error(`Note not found: ${noteId}`);
  }

  private resolveDevice(deviceId: string): any {
    const id = UUID.parse(deviceId);
    for (const unit of this.rootAdapter.audioUnits.adapters()) {
      for (const fx of unit.audioEffects.adapters()) {
        if (UUID.equals(fx.uuid, id)) return fx;
      }
      for (const fx of unit.midiEffects.adapters()) {
        if (UUID.equals(fx.uuid, id)) return fx;
      }
      const input = unit.input.adapter().unwrapOrNull();
      if (input && UUID.equals(input.uuid, id)) return input;
    }
    throw new Error(`Device not found: ${deviceId}`);
  }

  private resolveEffectFactory(name: string): EffectFactory {
    const key = name as keyof typeof EffectFactories.MergedNamed;
    const factory = EffectFactories.MergedNamed[key];
    if (!factory) {
      throw new Error(`Unknown effect factory: ${name}`);
    }
    return factory;
  }

  private attachTransportObservers() {
    const engine = this.engine;
    this.subscriptions.push(() =>
      engine.position.subscribe(() => this.broadcastTransportPosition()).terminate(),
    );
    this.subscriptions.push(() =>
      engine.isPlaying.subscribe(() => this.broadcastTransportState()).terminate(),
    );
    this.subscriptions.push(() =>
      engine.isRecording.subscribe(() => this.broadcastTransportState()).terminate(),
    );
    this.subscriptions.push(() =>
      engine.bpm.subscribe(() => this.broadcastTransportState()).terminate(),
    );
  }

  private broadcastState() {
    this.onStateChange?.(this.getState());
  }

  private broadcastTransportState() {
    this.broadcastState();
  }

  private broadcastTransportPosition() {
    const position = this.engine.position.getValue();
    this.onTransportPosition?.(position);
    if (this.engine.isPlaying.getValue()) {
      this.applyAutomation(position / 960);
    }
  }
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function generatePeaks(
  frames: ReadonlyArray<Float32Array>,
  width: number,
  channel: number,
): Float32Array {
  const ch = Math.min(channel, frames.length - 1);
  const data = frames[ch];
  const framesPerPixel = Math.max(1, Math.floor(data.length / width));
  const out = new Float32Array(width * 2);
  for (let i = 0; i < width; i++) {
    const start = i * framesPerPixel;
    const end = Math.min(start + framesPerPixel, data.length);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[i * 2] = min;
    out[i * 2 + 1] = max;
  }
  return out;
}

export function createBootEnv(audioContext: AudioContext, audioWorklets: AudioWorklets): BootEnv {
  const sampleService = new SampleService(audioContext);
  const soundfontService = new SoundfontService();
  const sampleManager = new GlobalSampleLoaderManager(SampleStorage.get() as any);
  const soundfontManager = new GlobalSoundfontLoaderManager(SoundfontStorage.get() as any);
  return {
    audioContext,
    audioWorklets,
    sampleService,
    soundfontService,
    sampleManager,
    soundfontManager,
  };
}
