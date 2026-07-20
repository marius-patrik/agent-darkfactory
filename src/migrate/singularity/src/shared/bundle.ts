import JSZip from "jszip";
import { type ProjectJson, projectJsonSchema } from "./schemas.js";

export interface BundleReadResult {
  project: ProjectJson;
  audioFiles: Map<string, Uint8Array>;
  engineBin?: Uint8Array;
}

export interface BundleWriteOptions {
  project: ProjectJson;
  audioFiles?: Map<string, Uint8Array>;
  engineBin?: Uint8Array;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export function createEmptyProject(name = "Untitled", sampleRate = 48000): ProjectJson {
  const now = new Date().toISOString();
  return {
    $schema: "vsdaw://project.json/v1",
    version: "1.0.0",
    createdBy: "vsdaw",
    createdAt: now,
    project: {
      name,
      sampleRate,
      tempo: 120,
      timeSignature: [4, 4],
      loop: { enabled: false, start: 0, end: 0 },
    },
    tracks: [
      {
        id: "track-1",
        name: "Audio 1",
        type: "audio",
        color: "#3b82f6",
        volumeDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        arm: false,
        inserts: [],
      },
    ],
    regions: [],
    midiClips: [],
    automation: [],
    mixer: { masterVolumeDb: 0 },
  };
}

export async function readBundle(data: Uint8Array): Promise<BundleReadResult> {
  if (!(data instanceof Uint8Array)) {
    throw new BundleError("Bundle data must be a Uint8Array");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new BundleError("Failed to parse ZIP archive");
  }

  const projectFile = zip.file("project.json");
  if (!projectFile) {
    throw new BundleError("Missing project.json in bundle");
  }

  const projectText = await projectFile.async("string");
  let project: unknown;
  try {
    project = JSON.parse(projectText);
  } catch {
    throw new BundleError("project.json is not valid JSON");
  }

  const parsed = projectJsonSchema.safeParse(project);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundleError(`project.json validation failed: ${issues}`);
  }

  const audioFiles = new Map<string, Uint8Array>();
  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (relativePath.startsWith("audio/")) {
      const safeName = sanitizeAudioPath(relativePath);
      if (!safeName) continue;
      const buffer = await zipEntry.async("uint8array");
      audioFiles.set(safeName, buffer);
    }
  }

  const engineBinEntry = zip.file("engine.bin");
  const engineBin = engineBinEntry ? await engineBinEntry.async("uint8array") : undefined;

  return { project: parsed.data, audioFiles, engineBin };
}

export async function writeBundle(
  project: ProjectJson,
  audioFiles: Map<string, Uint8Array> = new Map(),
  engineBin?: Uint8Array,
): Promise<Uint8Array> {
  const parsed = projectJsonSchema.safeParse(project);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundleError(`Invalid project data: ${issues}`);
  }

  const zip = new JSZip();
  zip.file("project.json", JSON.stringify(parsed.data, null, 2));

  if (engineBin && engineBin.byteLength > 0) {
    zip.file("engine.bin", engineBin);
  }

  if (audioFiles.size > 0) {
    const audioFolder = zip.folder("audio");
    if (!audioFolder) {
      throw new BundleError("Failed to create audio folder in bundle");
    }
    for (const [relativePath, data] of audioFiles) {
      const name = sanitizeAudioPath(relativePath);
      if (!name) {
        throw new BundleError(`Invalid audio file path: ${relativePath}`);
      }
      audioFolder.file(name.replace(/^audio\//, ""), data);
    }
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * Sanitizes an audio file path so it stays inside the bundle's audio/ folder.
 * Returns a canonical path like "audio/<safe-name>" or undefined if invalid.
 */
function sanitizeAudioPath(input: string): string | undefined {
  if (!input || typeof input !== "string") return undefined;

  // Normalize separators and collapse redundant slashes.
  let normalized = input.replace(/\\/g, "/").replace(/\/+/g, "/").trim();

  // Strip leading "audio/" so we can re-apply it consistently.
  normalized = normalized.replace(/^audio\//, "");

  // Reject path traversal, absolute paths, hidden files, and empty names.
  if (
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.startsWith("/") ||
    normalized.startsWith(".") ||
    normalized.length === 0
  ) {
    return undefined;
  }

  const segments = normalized.split("/");
  if (segments.length !== 1) {
    // Only flat audio files are supported; nested folders are rejected.
    return undefined;
  }

  const fileName = segments[0];
  if (!/^[\w\-. ]+\.\w+$/i.test(fileName)) {
    return undefined;
  }

  return `audio/${fileName}`;
}
