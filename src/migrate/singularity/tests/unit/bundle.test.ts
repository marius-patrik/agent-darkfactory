import {
  BundleError,
  createEmptyProject,
  readBundle,
  writeBundle,
} from "../../src/shared/bundle.js";
import { projectJsonSchema } from "../../src/shared/schemas.js";

describe("bundle", () => {
  test("createEmptyProject produces a valid project.json", () => {
    const project = createEmptyProject("Test", 44100);
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(true);
    expect(project.project.name).toBe("Test");
    expect(project.project.sampleRate).toBe(44100);
    expect(project.tracks).toHaveLength(1);
  });

  test("writeBundle and readBundle round-trip without audio", async () => {
    const project = createEmptyProject("Round-trip", 48000);
    const bytes = await writeBundle(project);
    expect(bytes.length).toBeGreaterThan(0);

    const { project: readProject, audioFiles } = await readBundle(bytes);
    expect(readProject.project.name).toBe("Round-trip");
    expect(audioFiles.size).toBe(0);
  });

  test("writeBundle embeds audio files", async () => {
    const project = createEmptyProject("With audio", 48000);
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
    const audioFiles = new Map<string, Uint8Array>([["audio/test.wav", audio]]);
    const bytes = await writeBundle(project, audioFiles);

    const { audioFiles: readAudio } = await readBundle(bytes);
    expect(readAudio.size).toBe(1);
    expect(readAudio.has("audio/test.wav")).toBe(true);
    expect(readAudio.get("audio/test.wav")).toEqual(audio);
  });

  test("readBundle rejects non-ZIP data", async () => {
    await expect(readBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow(BundleError);
  });

  test("readBundle rejects ZIP without project.json", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readBundle(bytes)).rejects.toThrow(BundleError);
  });

  test("readBundle rejects invalid project.json content", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("project.json", "not json");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readBundle(bytes)).rejects.toThrow(BundleError);
  });
});
