// Derived from Understory at 912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2.
// Copyright 2026 Anirban Kar. Modified by Andromeda contributors.
// Licensed under the Apache License, Version 2.0.

import path from "node:path";
import {
  compareMemoryText,
  parseMemoryConcept,
  serializeMemoryConcept,
  sha256,
} from "./okf";
import type { CanonicalMemoryDocument, MemoryConceptFrontmatter, MemoryFrontmatterValue } from "./types";

const MAX_MIGRATION_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATION_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_MIGRATION_SOURCES = 10_000;
const MAX_MIGRATION_SOURCE_PATH_BYTES = 4 * 1024;
const MAX_MIGRATION_SOURCE_SEGMENT_BYTES = 255;
const MAX_MIGRATION_TOPIC_BYTES = 1024;
const SAFE_SOURCE_SEGMENT = /^[^\0\r\n/\\]+$/u;
const RESERVED_SLUGS = new Set(["agents", "claude", "index", "log", "readme"]);

export interface LegacyMemorySource {
  /** Stable, repository-relative provenance path. */
  sourcePath: string;
  bytes: string | Uint8Array;
  /** Sources with the same normalized topic are folded into one concept. */
  topic?: string;
}

export interface MemoryMigrationEvidence {
  sourcePath: string;
  sourceBytes: number;
  sha256: string;
  mediaType: "markdown" | "json" | "lean" | "coq" | "text";
}

export interface MemoryMigrationConcept extends CanonicalMemoryDocument {
  contentHash: string;
  evidence: MemoryMigrationEvidence[];
}

export interface MemoryMigrationReceipt {
  schemaVersion: 1;
  sourceCount: number;
  conceptCount: number;
  mergedSourceCount: number;
  sourceBytes: number;
  sources: MemoryMigrationEvidence[];
  concepts: { path: string; contentHash: string; sourceHashes: string[] }[];
  planHash: string;
}

export interface MemoryMigrationPlan {
  concepts: MemoryMigrationConcept[];
  receipt: MemoryMigrationReceipt;
}

interface NormalizedSource extends MemoryMigrationEvidence {
  text: string;
  topicKey: string;
  title: string;
}

function normalizeSourcePath(input: string): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(input)
  ) {
    throw new Error("memory migration source path must be repository-relative");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_MIGRATION_SOURCE_PATH_BYTES) {
    throw new Error(`memory migration source path exceeds ${MAX_MIGRATION_SOURCE_PATH_BYTES} bytes`);
  }
  if (input.includes("\\") || input.includes("//")) {
    throw new Error(`memory migration source path is not canonical: ${input}`);
  }
  const segments = input.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > MAX_MIGRATION_SOURCE_SEGMENT_BYTES ||
        !SAFE_SOURCE_SEGMENT.test(segment),
    )
  ) {
    throw new Error(`memory migration source path contains an unsafe segment: ${input}`);
  }
  return input.normalize("NFC");
}

function decodeSource(
  bytes: string | Uint8Array,
  sourcePath: string,
): { text: string; size: number; encoded: Buffer } {
  if (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) {
    throw new Error(`memory migration source bytes must be UTF-8 text at ${sourcePath}`);
  }
  const encoded = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (encoded.byteLength > MAX_MIGRATION_SOURCE_BYTES) {
    throw new Error(`memory migration source exceeds ${MAX_MIGRATION_SOURCE_BYTES} bytes: ${sourcePath}`);
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded),
      size: encoded.byteLength,
      encoded,
    };
  } catch {
    throw new Error(`memory migration source is not UTF-8 text: ${sourcePath}`);
  }
}

function mediaType(sourcePath: string): NormalizedSource["mediaType"] {
  switch (path.posix.extname(sourcePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "markdown";
    case ".json":
      return "json";
    case ".lean":
      return "lean";
    case ".v":
      return "coq";
    default:
      return "text";
  }
}

function heading(text: string): string | undefined {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function basenameTitle(sourcePath: string): string {
  const base = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
  return base
    .replace(/[-_.]+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    .trim();
}

function normalizeTopic(source: LegacyMemorySource, sourcePath: string, text: string): { key: string; title: string } {
  if (source.topic !== undefined && typeof source.topic !== "string") {
    throw new Error(`memory migration topic is invalid for ${sourcePath}`);
  }
  const supplied = source.topic?.trim();
  if (
    source.topic !== undefined &&
    (!supplied ||
      supplied !== source.topic ||
      /[\r\n\0]/.test(source.topic) ||
      Buffer.byteLength(source.topic, "utf8") > MAX_MIGRATION_TOPIC_BYTES)
  ) {
    throw new Error(`memory migration topic is invalid for ${sourcePath}`);
  }
  const title = supplied ?? heading(text) ?? basenameTitle(sourcePath);
  const key = title.normalize("NFKC").toLowerCase();
  if (
    !title ||
    Buffer.byteLength(title, "utf8") > MAX_MIGRATION_TOPIC_BYTES ||
    Buffer.byteLength(key, "utf8") > MAX_MIGRATION_TOPIC_BYTES
  ) {
    throw new Error(`memory migration topic is invalid for ${sourcePath}`);
  }
  return { key, title };
}

function slug(value: string): string {
  let result = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result) result = `concept-${sha256(value).slice(0, 12)}`;
  if (RESERVED_SLUGS.has(result)) result = `imported-${result}`;
  return result;
}

function normalizedSource(source: LegacyMemorySource): NormalizedSource {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("memory migration source must be an object");
  }
  const sourcePath = normalizeSourcePath(source.sourcePath);
  const decoded = decodeSource(source.bytes, sourcePath);
  const topic = normalizeTopic(source, sourcePath, decoded.text);
  return {
    sourcePath,
    sourceBytes: decoded.size,
    sha256: sha256(decoded.encoded),
    mediaType: mediaType(sourcePath),
    text: decoded.text,
    topicKey: topic.key,
    title: topic.title,
  };
}

function longestRun(value: string, marker: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === marker) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function fenced(source: NormalizedSource): string {
  if (source.mediaType === "markdown") return source.text;
  const language =
    source.mediaType === "json" ? "json" : source.mediaType === "lean" ? "lean" : source.mediaType === "coq" ? "coq" : "text";
  const backticks = Math.max(3, longestRun(source.text, "`") + 1);
  const tildes = Math.max(3, longestRun(source.text, "~") + 1);
  const marker = backticks <= tildes ? "`" : "~";
  const fence = marker.repeat(marker === "`" ? backticks : tildes);
  const separator = source.text.endsWith("\n") ? "" : "\n";
  return `${fence}${language}\n${source.text}${separator}${fence}`;
}

function sourceBody(sources: readonly NormalizedSource[]): string {
  if (sources.length === 1) {
    const source = sources[0];
    if (source.mediaType === "markdown") {
      try {
        return parseMemoryConcept({ path: "/concepts/source.md", raw: source.text }).body;
      } catch {
        return source.text;
      }
    }
    return fenced(source);
  }
  return sources.map((source) => `## Source: ${source.sourcePath}\n\n${fenced(source)}`).join("\n\n");
}

function sourceFrontmatter(sources: readonly NormalizedSource[]): MemoryConceptFrontmatter {
  let existing: MemoryConceptFrontmatter | undefined;
  if (sources.length === 1 && sources[0].mediaType === "markdown") {
    try {
      existing = parseMemoryConcept({ path: "/concepts/source.md", raw: sources[0].text }).frontmatter;
    } catch {
      // Historical Markdown without OKF frontmatter is imported as legacy memory.
    }
  }
  const evidence = sources.map((source) => ({
    source_path: source.sourcePath,
    sha256: source.sha256,
    media_type: source.mediaType,
  })) as unknown as MemoryFrontmatterValue;
  return {
    ...(existing ?? { type: "legacy-memory" }),
    title: existing?.title ?? sources[0].title,
    description:
      existing?.description ??
      `Imported from ${sources.length} validated source${sources.length === 1 ? "" : "s"}.`,
    andromeda_evidence: evidence,
  };
}

function uniqueConceptPaths(groups: readonly { key: string; title: string }[]): Map<string, string> {
  const result = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const group of groups) {
    const base = slug(group.title);
    let resolved = base;
    if (owners.has(resolved) && owners.get(resolved) !== group.key) {
      const suffix = sha256(group.key);
      for (let length = 12; owners.has(resolved) && length <= suffix.length; length += 4) {
        resolved = `${base}-${suffix.slice(0, length)}`;
      }
    }
    if (owners.has(resolved) && owners.get(resolved) !== group.key) {
      throw new Error(`memory migration could not derive a unique concept path for ${group.title}`);
    }
    owners.set(resolved, group.key);
    result.set(group.key, `/concepts/${resolved}.md`);
  }
  return result;
}

function receiptHash(receipt: Omit<MemoryMigrationReceipt, "planHash">): string {
  return sha256(JSON.stringify(receipt));
}

function preflightMigrationSources(inputs: readonly LegacyMemorySource[]): number {
  let totalBytes = 0;
  for (const source of inputs) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("memory migration source must be an object");
    }
    normalizeSourcePath(source.sourcePath);
    if (source.topic !== undefined) {
      if (
        typeof source.topic !== "string" ||
        Buffer.byteLength(source.topic, "utf8") > MAX_MIGRATION_TOPIC_BYTES ||
        !source.topic.trim() ||
        source.topic.trim() !== source.topic ||
        /[\r\n\0]/.test(source.topic)
      ) {
        throw new Error(`memory migration topic is invalid for ${source.sourcePath}`);
      }
    }
    if (typeof source.bytes !== "string" && !(source.bytes instanceof Uint8Array)) {
      throw new Error(`memory migration source bytes must be UTF-8 text at ${source.sourcePath}`);
    }
    const sourceBytes =
      typeof source.bytes === "string" ? Buffer.byteLength(source.bytes, "utf8") : source.bytes.byteLength;
    if (sourceBytes > MAX_MIGRATION_SOURCE_BYTES) {
      throw new Error(`memory migration source exceeds ${MAX_MIGRATION_SOURCE_BYTES} bytes: ${source.sourcePath}`);
    }
    totalBytes += sourceBytes;
    if (totalBytes > MAX_MIGRATION_TOTAL_BYTES) {
      throw new Error(`memory migration sources exceed ${MAX_MIGRATION_TOTAL_BYTES} bytes`);
    }
  }
  return totalBytes;
}

/**
 * Build a deterministic, reviewable migration plan. This function performs no
 * writes; the state service must publish the returned concepts transactionally.
 */
export function planMemoryMigration(inputs: readonly LegacyMemorySource[]): MemoryMigrationPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("memory migration requires at least one source");
  if (inputs.length > MAX_MIGRATION_SOURCES) {
    throw new Error(`memory migration exceeds ${MAX_MIGRATION_SOURCES} sources`);
  }
  const totalBytes = preflightMigrationSources(inputs);
  const sources = inputs
    .map(normalizedSource)
    .sort((left, right) => compareMemoryText(left.sourcePath, right.sourcePath));
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1].sourcePath === sources[index].sourcePath) {
      throw new Error(`memory migration repeats source path ${sources[index].sourcePath}`);
    }
  }
  const grouped = new Map<string, NormalizedSource[]>();
  for (const source of sources) {
    const members = grouped.get(source.topicKey) ?? [];
    members.push(source);
    grouped.set(source.topicKey, members);
  }
  const groupKeys = [...grouped.keys()].sort(compareMemoryText);
  const paths = uniqueConceptPaths(
    groupKeys.map((key) => ({ key, title: grouped.get(key)![0].title })),
  );
  const concepts: MemoryMigrationConcept[] = groupKeys.map((key) => {
    const members = grouped.get(key)!;
    const conceptPath = paths.get(key)!;
    const raw = serializeMemoryConcept(sourceFrontmatter(members), sourceBody(members));
    return {
      path: conceptPath,
      raw,
      contentHash: sha256(raw),
      evidence: members.map(({ sourcePath, sourceBytes, sha256: hash, mediaType: kind }) => ({
        sourcePath,
        sourceBytes,
        sha256: hash,
        mediaType: kind,
      })),
    };
  });
  concepts.sort((left, right) => compareMemoryText(left.path, right.path));
  const withoutHash: Omit<MemoryMigrationReceipt, "planHash"> = {
    schemaVersion: 1,
    sourceCount: sources.length,
    conceptCount: concepts.length,
    mergedSourceCount: sources.length - concepts.length,
    sourceBytes: totalBytes,
    sources: sources.map(({ sourcePath, sourceBytes, sha256: hash, mediaType: kind }) => ({
      sourcePath,
      sourceBytes,
      sha256: hash,
      mediaType: kind,
    })),
    concepts: concepts.map((concept) => ({
      path: concept.path,
      contentHash: concept.contentHash,
      sourceHashes: concept.evidence.map((evidence) => evidence.sha256),
    })),
  };
  return { concepts, receipt: { ...withoutHash, planHash: receiptHash(withoutHash) } };
}
