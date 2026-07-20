import {
  type BundleReadResult,
  createEmptyProject,
  readBundle,
  writeBundle,
} from "../../src/shared/bundle.js";
import { projectJsonSchema } from "../../src/shared/schemas.js";

describe("project save/load round-trip", () => {
  test("empty project round-trips through bundle", async () => {
    const project = createEmptyProject("Round-trip", 48000);
    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.$schema).toBe("vsdaw://project.json/v1");
    expect(readProject.version).toBe(project.version);
    expect(readProject.createdBy).toBe("vsdaw");
    expect(readProject.project.name).toBe("Round-trip");
    expect(readProject.project.sampleRate).toBe(48000);
    expect(readProject.tracks).toHaveLength(1);
  });

  test("project with multiple tracks round-trips", async () => {
    const project = createEmptyProject("Multi-track", 44100);
    project.tracks.push(
      {
        id: "track-2",
        name: "MIDI 1",
        type: "midi",
        color: "#10b981",
        volumeDb: -6,
        pan: -0.25,
        mute: false,
        solo: true,
        arm: false,
        inserts: [],
      },
      {
        id: "track-3",
        name: "Bus A",
        type: "bus",
        color: "#f59e0b",
        volumeDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        arm: false,
        inserts: [],
      },
    );

    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.tracks).toHaveLength(3);
    expect(readProject.tracks[1].name).toBe("MIDI 1");
    expect(readProject.tracks[1].type).toBe("midi");
    expect(readProject.tracks[1].solo).toBe(true);
    expect(readProject.tracks[2].type).toBe("bus");
  });

  test("project with regions round-trips", async () => {
    const project = createEmptyProject("With regions", 48000);
    project.project.tempo = 128;
    project.project.timeSignature = [3, 4];
    project.regions.push({
      id: "region-1",
      trackId: "track-1",
      audioFile: "audio/vocal.wav",
      start: 0,
      duration: 48000,
      offset: 0,
      fadeIn: { type: "linear", duration: 100 },
      fadeOut: { type: "linear", duration: 200 },
    });

    const bytes = await writeBundle(project);
    const { project: readProject } = await readBundle(bytes);

    expect(readProject.regions).toHaveLength(1);
    expect(readProject.regions[0].trackId).toBe("track-1");
    expect(readProject.regions[0].audioFile).toBe("audio/vocal.wav");
    expect(readProject.regions[0].duration).toBe(48000);
    expect(readProject.project.tempo).toBe(128);
    expect(readProject.project.timeSignature).toEqual([3, 4]);
  });

  test("project with embedded audio files round-trips", async () => {
    const project = createEmptyProject("With embedded audio", 48000);
    const audioFiles = new Map<string, Uint8Array>([
      ["audio/kick.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00])],
      ["audio/snare.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0x00])],
    ]);

    const bytes = await writeBundle(project, audioFiles);
    const { project: readProject, audioFiles: readAudio } = await readBundle(bytes);

    expect(readProject.project.name).toBe("With embedded audio");
    expect(readAudio.size).toBe(2);
    expect(readAudio.get("audio/kick.wav")).toEqual(audioFiles.get("audio/kick.wav"));
    expect(readAudio.get("audio/snare.wav")).toEqual(audioFiles.get("audio/snare.wav"));
  });

  test("invalid audio paths are rejected during write", async () => {
    const project = createEmptyProject("Bad path", 48000);
    const audioFiles = new Map<string, Uint8Array>([
      ["audio/../escape.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46])],
    ]);

    await expect(writeBundle(project, audioFiles)).rejects.toThrow("Invalid audio file path");
  });

  test("round-tripped project still validates against schema", async () => {
    const project = createEmptyProject("Validated", 48000);
    project.tracks.push({
      id: "track-2",
      name: "Synth",
      type: "midi",
      color: "#8b5cf6",
      volumeDb: -12,
      pan: 0.5,
      mute: true,
      solo: false,
      arm: true,
      inserts: [],
    });
    project.regions.push({
      id: "region-1",
      trackId: "track-1",
      audioFile: "audio/loop.wav",
      start: 0,
      duration: 96000,
      offset: 0,
      fadeIn: { type: "linear", duration: 0 },
      fadeOut: { type: "linear", duration: 0 },
    });

    const bytes = await writeBundle(project);
    const { project: readProject }: BundleReadResult = await readBundle(bytes);

    const result = projectJsonSchema.safeParse(readProject);
    expect(result.success).toBe(true);
  });

  test("re-read project ignores non-audio zip entries", async () => {
    const { default: JSZip } = await import("jszip");
    const project = createEmptyProject("Extras", 48000);
    const zip = new JSZip();
    zip.file("project.json", JSON.stringify(project, null, 2));
    zip.file("notes.txt", "backup notes");
    zip.folder("audio");
    zip.file("audio/loop.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const { project: readProject, audioFiles } = await readBundle(bytes);

    expect(readProject.project.name).toBe("Extras");
    expect(audioFiles.size).toBe(1);
    expect(audioFiles.has("audio/loop.wav")).toBe(true);
  });

  test("project with engine.bin round-trips", async () => {
    const project = createEmptyProject("Engine state", 48000);
    const engineBin = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    const bytes = await writeBundle(project, new Map(), engineBin);
    const { project: readProject, engineBin: readEngineBin } = await readBundle(bytes);

    expect(readProject.project.name).toBe("Engine state");
    expect(readEngineBin).toEqual(engineBin);
  });
});
