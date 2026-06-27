import { useCallback, useEffect, useState } from "react";
import { messageBus } from "./messageBus.js";
import type {
  AutomationTarget,
  BrowserNode,
  DeviceCategory,
  DeviceParameter,
  HostMessage,
  NoteState,
  SelectionState,
  TimePosition,
  TimeSignature,
  TrackState,
  ViewMessage,
  ViewName,
} from "./types.js";

const defaultPosition: TimePosition = { bars: 1, beats: 1, ticks: 0, seconds: 0 };
const defaultTimeSignature: TimeSignature = { numerator: 4, denominator: 4 };

export function useViewState(view: ViewName) {
  const [ready, setReady] = useState(false);
  const [projectName, setProjectName] = useState<string>("Untitled");
  const [saved, setSaved] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [isMetronomeEnabled, setIsMetronomeEnabled] = useState(false);
  const [position, setPosition] = useState<TimePosition>(defaultPosition);
  const [bpm, setBpm] = useState(120);
  const [timeSignature, setTimeSignature] = useState<TimeSignature>(defaultTimeSignature);
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [notes, setNotes] = useState<NoteState[]>([]);
  const [selection, setSelection] = useState<SelectionState>({});
  const [browserRoot, setBrowserRoot] = useState<BrowserNode | null>(null);
  const [deviceParameters, setDeviceParameters] = useState<{
    deviceId: string;
    parameters: DeviceParameter[];
  } | null>(null);
  const [deviceParametersById, setDeviceParametersById] = useState<
    Record<string, DeviceParameter[]>
  >({});
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((message: ViewMessage) => {
    messageBus.send(message);
  }, []);

  useEffect(() => {
    messageBus.send({ type: "view/ready", view });
    setReady(true);

    const unsubscribe = messageBus.subscribe((message: HostMessage) => {
      switch (message.type) {
        case "host/project":
          setProjectName(message.name);
          setSaved(message.saved);
          break;
        case "host/transport":
          setIsPlaying(message.isPlaying);
          setIsRecording(message.isRecording);
          setIsLooping(message.isLooping);
          setIsMetronomeEnabled(message.isMetronomeEnabled);
          setPosition(message.position);
          setBpm(message.bpm);
          setTimeSignature(message.timeSignature);
          break;
        case "host/tracks":
          setTracks(message.tracks);
          break;
        case "host/notes":
          setNotes(message.notes);
          break;
        case "host/selection":
          setSelection(message);
          break;
        case "host/browser":
          setBrowserRoot(message.root);
          break;
        case "host/deviceParameters":
          setDeviceParameters({ deviceId: message.deviceId, parameters: message.parameters });
          setDeviceParametersById((prev) => ({
            ...prev,
            [message.deviceId]: message.parameters,
          }));
          break;
        case "host/error":
          setError(message.message);
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [view]);

  const transport = {
    play: () => send({ type: "transport/play" }),
    pause: () => send({ type: "transport/pause" }),
    stop: () => send({ type: "transport/stop" }),
    record: () => send({ type: "transport/record" }),
    toggleLoop: () => send({ type: "transport/toggleLoop" }),
    toggleMetronome: () => send({ type: "transport/toggleMetronome" }),
    setTempo: (value: number) => send({ type: "transport/setTempo", bpm: value }),
    setTimeSignature: (value: TimeSignature) =>
      send({ type: "transport/setTimeSignature", timeSignature: value }),
    seek: (beats: number) => send({ type: "transport/seek", beats }),
  };

  const trackActions = {
    setMute: (trackId: string, muted: boolean) => send({ type: "track/setMute", trackId, muted }),
    setSolo: (trackId: string, soloed: boolean) => send({ type: "track/setSolo", trackId, soloed }),
    setArm: (trackId: string, armed: boolean) => send({ type: "track/setArm", trackId, armed }),
    setVolume: (trackId: string, volume: number) =>
      send({ type: "track/setVolume", trackId, volume }),
    setPan: (trackId: string, pan: number) => send({ type: "track/setPan", trackId, pan }),
    setName: (trackId: string, name: string) => send({ type: "track/setName", trackId, name }),
    createTrack: (trackType: "audio" | "midi" | "bus", name?: string, color?: string) =>
      send({ type: "track/create", trackType, name, color }),
    deleteTrack: (trackId: string) => send({ type: "track/delete", trackId }),
    setColor: (trackId: string, color: string) => send({ type: "track/setColor", trackId, color }),
    addInsert: (trackId: string, deviceName: string, slot?: DeviceCategory, insertIndex?: number) =>
      send({ type: "track/addInsert", trackId, deviceName, slot, insertIndex }),
  };

  const timelineActions = {
    selectRegion: (regionId: string | null) => send({ type: "timeline/selectRegion", regionId }),
    moveRegion: (regionId: string, start: number) =>
      send({ type: "timeline/moveRegion", regionId, start }),
  };

  const automationActions = {
    addLane: (trackId: string, target: AutomationTarget) =>
      send({ type: "automation/addLane", trackId, target }),
    removeLane: (laneId: string) => send({ type: "automation/removeLane", laneId }),
    addPoint: (laneId: string, position: number, value: number) =>
      send({ type: "automation/addPoint", laneId, position, value }),
    movePoint: (pointId: string, position?: number, value?: number) =>
      send({ type: "automation/movePoint", pointId, position, value }),
    deletePoint: (pointId: string) => send({ type: "automation/deletePoint", pointId }),
  };

  const pianoRollActions = {
    createNote: (
      regionId: string,
      position: number,
      duration: number,
      pitch: number,
      velocity: number,
    ) => send({ type: "note/create", regionId, position, duration, pitch, velocity }),
    moveNote: (noteId: string, position?: number, pitch?: number) =>
      send({ type: "note/move", noteId, position, pitch }),
    resizeNote: (noteId: string, duration: number) => send({ type: "note/resize", noteId, duration }),
    deleteNote: (noteId: string) => send({ type: "note/delete", noteId }),
    setNoteVelocity: (noteId: string, velocity: number) =>
      send({ type: "note/setVelocity", noteId, velocity }),
  };

  const mixerActions = {
    openDevice: (trackId: string, slotIndex: number) =>
      send({ type: "mixer/openDevice", trackId, slotIndex }),
    setOutput: (trackId: string, outputTrackId: string | null) =>
      send({ type: "track/setOutput", trackId, outputTrackId }),
    addSend: (trackId: string, targetTrackId: string, amount?: number) =>
      send({ type: "track/addSend", trackId, targetTrackId, amount }),
    removeSend: (sendId: string) => send({ type: "track/removeSend", sendId }),
    setSendAmount: (sendId: string, amount: number) =>
      send({ type: "track/setSendAmount", sendId, amount }),
  };

  const deviceActions = {
    getParameters: (deviceId: string) => send({ type: "device/getParameters", deviceId }),
    setParameter: (deviceId: string, parameter: string, value: number | boolean) =>
      send({ type: "device/setParameter", deviceId, parameter, value }),
  };

  const browserActions = {
    preview: (nodeId: string) => send({ type: "browser/preview", nodeId }),
    dragStart: (nodeId: string) => send({ type: "browser/dragStart", nodeId }),
  };

  const commands = {
    undo: () => send({ type: "command/undo" }),
    redo: () => send({ type: "command/redo" }),
    delete: () => send({ type: "command/delete" }),
    duplicate: () => send({ type: "command/duplicate" }),
    export: () => send({ type: "command/export" }),
    importAudio: () => send({ type: "command/importAudio" }),
    importMidi: () => send({ type: "command/importMidi" }),
    showView: (target: ViewName) => send({ type: "command/show", view: target }),
  };

  return {
    ready,
    projectName,
    saved,
    isPlaying,
    isRecording,
    isLooping,
    isMetronomeEnabled,
    position,
    bpm,
    timeSignature,
    tracks,
    notes,
    selection,
    browserRoot,
    deviceParameters,
    deviceParametersById,
    error,
    transport,
    trackActions,
    timelineActions,
    automationActions,
    pianoRollActions,
    mixerActions,
    deviceActions,
    browserActions,
    commands,
    send,
  };
}
