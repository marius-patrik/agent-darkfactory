import type { MessageRouter } from "../../src/extension/messageRouter.js";
import { ProjectStateProjector } from "../../src/extension/stateProjector.js";
import type {
  NoteState,
  ProjectState,
  RegionState,
  TrackState,
  TransportState,
} from "../../src/shared/protocol.js";
import type { HostMessage } from "../../src/views/shared/types.js";

const PROJECT_ID = "project-test";
const DEFAULT_TRANSPORT: TransportState = {
  isPlaying: false,
  isRecording: false,
  isLooping: false,
  position: 0,
  bpm: 120,
  timeSignature: [4, 4],
  loopStart: 0,
  loopEnd: 0,
};

function createRouter(): MessageRouter {
  return {
    broadcastToViews: jest.fn(),
    routeToViews: jest.fn(),
    requestEngine: jest.fn().mockResolvedValue({
      type: "device.list",
      payload: [
        { id: "Tape", name: "Tape", category: "instrument" },
        { id: "Compressor", name: "Compressor", category: "audio-effect" },
      ],
    }),
  } as unknown as MessageRouter;
}

function createProjectState(
  overrides: Partial<ProjectState> = {},
  transportOverrides: Partial<TransportState> = {},
): ProjectState {
  return {
    projectId: PROJECT_ID,
    tracks: [],
    regions: [],
    notes: [],
    automationLanes: [],
    automationPoints: [],
    transport: { ...DEFAULT_TRANSPORT, ...transportOverrides },
    ...overrides,
  };
}

function createTrack(overrides: Partial<TrackState> = {}): TrackState {
  return {
    id: "track-1",
    type: "audio",
    name: "Drums",
    index: 0,
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    arm: false,
    inserts: [],
    sends: [],
    ...overrides,
  };
}

function createRegion(overrides: Partial<RegionState> = {}): RegionState {
  return {
    id: "region-1",
    trackId: "track-1",
    type: "audio",
    position: 4,
    duration: 8,
    name: "Loop",
    hue: 180,
    ...overrides,
  };
}

describe("ProjectStateProjector", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("broadcasts host/transport with bars/beats/ticks and seconds", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    // 4800 PPQN ticks = 5 beats at 960 PPQN, 120 BPM => 2.5 seconds.
    const state = createProjectState({}, { position: 4800, bpm: 120, timeSignature: [4, 4] });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const transportCall = calls.find(
      ([id, msg]) => id === PROJECT_ID && msg.type === "host/transport",
    );
    expect(transportCall).toBeDefined();
    if (!transportCall) throw new Error("transport message not broadcast");
    const transport = transportCall[1] as Extract<HostMessage, { type: "host/transport" }>;
    expect(transport.isPlaying).toBe(false);
    expect(transport.bpm).toBe(120);
    expect(transport.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    expect(transport.position).toEqual({ bars: 1, beats: 1, ticks: 0, seconds: 2.5 });
  });

  test("broadcasts host/tracks with converted volume, pan, color and regions", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const track = createTrack({ volumeDb: -6.020599913279624, pan: -0.5 });
    const region = createRegion();
    const state = createProjectState({ tracks: [track], regions: [region] });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/tracks");
    expect(tracksCall).toBeDefined();
    if (!tracksCall) throw new Error("tracks message not broadcast");
    const tracks = tracksCall[1] as Extract<HostMessage, { type: "host/tracks" }>;
    expect(tracks.tracks).toHaveLength(1);

    const viewTrack = tracks.tracks[0];
    expect(viewTrack.id).toBe("track-1");
    expect(viewTrack.name).toBe("Drums");
    expect(viewTrack.volume).toBeCloseTo(0.5, 5);
    expect(viewTrack.pan).toBe(-0.5);
    expect(viewTrack.muted).toBe(false);
    expect(viewTrack.soloed).toBe(false);
    expect(viewTrack.armed).toBe(false);
    expect(viewTrack.height).toBe(48);
    expect(viewTrack.color).toMatch(/^hsl\(/);

    expect(viewTrack.regions).toHaveLength(1);
    expect(viewTrack.regions[0]).toMatchObject({
      id: "region-1",
      start: 4,
      duration: 8,
      name: "Loop",
    });
    expect(viewTrack.regions[0].color).toMatch(/^hsl\(/);
  });

  test("broadcasts automation lanes and points with increased track height", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const track = createTrack();
    const lane = {
      id: "lane-1",
      trackId: track.id,
      target: { type: "volume" as const, trackId: track.id },
    };
    const point = { id: "point-1", laneId: "lane-1", position: 2, value: 0.75 };
    const state = createProjectState({
      tracks: [track],
      automationLanes: [lane],
      automationPoints: [point],
    });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/tracks");
    expect(tracksCall).toBeDefined();
    if (!tracksCall) throw new Error("tracks message not broadcast");
    const tracks = tracksCall[1] as Extract<HostMessage, { type: "host/tracks" }>;
    expect(tracks.tracks).toHaveLength(1);

    const viewTrack = tracks.tracks[0];
    expect(viewTrack.height).toBe(48 + 60);
    expect(viewTrack.automationLanes).toHaveLength(1);
    expect(viewTrack.automationLanes[0].id).toBe("lane-1");
    expect(viewTrack.automationLanes[0].points).toEqual([point]);
  });

  test("broadcasts host/notes with converted note positions", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const note: NoteState = {
      id: "note-1",
      regionId: "region-1",
      position: 4,
      duration: 2,
      pitch: 60,
      velocity: 100,
    };
    const state = createProjectState({ notes: [note] });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const notesCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/notes");
    expect(notesCall).toBeDefined();
    if (!notesCall) throw new Error("notes message not broadcast");
    const notes = notesCall[1] as Extract<HostMessage, { type: "host/notes" }>;
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toEqual({
      id: "note-1",
      regionId: "region-1",
      start: 4,
      duration: 2,
      pitch: 60,
      velocity: 100,
    });
  });

  test("defaults track color when engine track has none", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    const track = createTrack({ color: undefined });
    const state = createProjectState({ tracks: [track] });
    projector.handleStateUpdate(state);

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const tracksCall = calls.find(([id, msg]) => msg.type === "host/tracks") as [
      string,
      HostMessage,
    ];
    const viewTrack = (tracksCall[1] as Extract<HostMessage, { type: "host/tracks" }>).tracks[0];
    expect(viewTrack.color).toMatch(/^hsl\(/);
  });

  test("throttles transport position updates", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
      throttleMs: 50,
    });

    projector.handleStateUpdate(createProjectState({}, { position: 0 }));
    (router.broadcastToViews as jest.Mock).mockClear();

    projector.handleTransportPositionChanged(960);
    projector.handleTransportPositionChanged(1920);
    projector.handleTransportPositionChanged(2880);

    expect(router.broadcastToViews).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);

    expect(router.broadcastToViews).toHaveBeenCalledTimes(1);
    const call = (router.broadcastToViews as jest.Mock).mock.calls[0] as [string, HostMessage];
    expect(call[0]).toBe(PROJECT_ID);
    const transport = call[1] as Extract<HostMessage, { type: "host/transport" }>;
    expect(transport.type).toBe("host/transport");
    // 2880 ticks = 3 beats => bar 0, beat 3, tick 0.
    expect(transport.position).toEqual({ bars: 0, beats: 3, ticks: 0, seconds: 1.5 });
  });

  test("broadcasts host/selection when selection changes", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    projector.updateSelection({ regionId: "region-1" });

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const selectionCall = calls.find(([id, msg]) => msg.type === "host/selection");
    expect(selectionCall).toBeDefined();
    if (!selectionCall) throw new Error("selection message not broadcast");
    expect(selectionCall[1]).toMatchObject({ type: "host/selection", regionId: "region-1" });

    (router.broadcastToViews as jest.Mock).mockClear();
    projector.updateSelection({ regionId: "region-1" });
    expect(router.broadcastToViews).not.toHaveBeenCalled();
  });

  test("broadcasts host/project from session getters", () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "My Song",
      getSaved: () => false,
    });

    projector.broadcastProject();

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const projectCall = calls.find(([id, msg]) => msg.type === "host/project");
    expect(projectCall).toBeDefined();
    if (!projectCall) throw new Error("project message not broadcast");
    expect(projectCall[1]).toEqual({ type: "host/project", name: "My Song", saved: false });
  });

  test("requestDeviceList broadcasts host/browser with device tree", async () => {
    const router = createRouter();
    const projector = new ProjectStateProjector({
      projectId: PROJECT_ID,
      router,
      getProjectName: () => "Test",
      getSaved: () => true,
    });

    await projector.requestDeviceList();

    expect(router.requestEngine).toHaveBeenCalledWith(PROJECT_ID, "device.list", undefined, {
      responseType: "device.list",
      timeoutMs: 10000,
    });

    const calls = (router.broadcastToViews as jest.Mock).mock.calls as [string, HostMessage][];
    const browserCall = calls.find(([id, msg]) => id === PROJECT_ID && msg.type === "host/browser");
    expect(browserCall).toBeDefined();
    if (!browserCall) throw new Error("browser message not broadcast");
    const browser = browserCall[1] as Extract<HostMessage, { type: "host/browser" }>;
    expect(browser.root.type).toBe("folder");
    expect(browser.root.children?.length).toBeGreaterThan(0);
  });
});
