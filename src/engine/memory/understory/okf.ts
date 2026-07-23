// Derived from Understory at 912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2.
// Copyright 2026 Anirban Kar. Modified by Andromeda contributors.
// Licensed under the Apache License, Version 2.0.

import { createHash } from "node:crypto";
import type {
  CanonicalMemoryDocument,
  MemoryConceptFrontmatter,
  MemoryFrontmatterValue,
  ParsedMemoryConcept,
} from "./types";

export const MAX_MEMORY_CONCEPT_BYTES = 4 * 1024 * 1024;
export const MAX_MEMORY_CONCEPT_PATH_BYTES = 4 * 1024;
export const MAX_MEMORY_CONCEPT_SEGMENT_BYTES = 255;
export const MAX_MEMORY_FRONTMATTER_DEPTH = 32;
export const MAX_MEMORY_FRONTMATTER_NODES = 10_000;
export const MAX_MEMORY_FRONTMATTER_KEY_BYTES = 512;
export const MAX_MEMORY_FRONTMATTER_TAGS = 128;
export const MAX_MEMORY_FRONTMATTER_TAG_BYTES = 512;

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED_FILENAMES = new Set(["agents.md", "claude.md", "index.md", "log.md", "readme.md"]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UNSUPPORTED_YAML_FEATURE = /(^|[\s[{},])(?:[&*!][A-Za-z0-9_-]+|<<\s*:)/m;

export class MemoryConceptError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_PATH"
      | "RESERVED_PATH"
      | "INVALID_FRONTMATTER"
      | "INVALID_MARKDOWN"
      | "TOO_LARGE",
  ) {
    super(message);
    this.name = "MemoryConceptError";
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Locale-independent UTF-16 code-unit ordering, matching JavaScript's relational comparison. */
export function compareMemoryText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical memory paths are deliberately portable across private-data clones.
 * Callers must supply lowercase ASCII paths rather than relying on host-specific
 * normalization or case folding.
 */
export function canonicalMemoryConceptPath(input: string): string {
  if (typeof input !== "string" || !input || input.includes("\0") || /[\r\n]/.test(input)) {
    throw new MemoryConceptError("memory concept path is required and must be one line", "INVALID_PATH");
  }
  if (input.includes("\\") || !input.startsWith("/") || input.includes("//")) {
    throw new MemoryConceptError(`memory concept path is not canonical: ${input}`, "INVALID_PATH");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_MEMORY_CONCEPT_PATH_BYTES) {
    throw new MemoryConceptError(`memory concept path exceeds ${MAX_MEMORY_CONCEPT_PATH_BYTES} bytes`, "INVALID_PATH");
  }
  const segments = input.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        Buffer.byteLength(segment, "utf8") > MAX_MEMORY_CONCEPT_SEGMENT_BYTES ||
        !SAFE_SEGMENT.test(segment),
    )
  ) {
    throw new MemoryConceptError(`memory concept path contains a non-portable segment: ${input}`, "INVALID_PATH");
  }
  if (segments.some((segment) => segment === "." || segment === "..") || !input.endsWith(".md")) {
    throw new MemoryConceptError(`memory concept path must identify a Markdown concept: ${input}`, "INVALID_PATH");
  }
  const filename = segments.at(-1)!;
  if (RESERVED_FILENAMES.has(filename)) {
    throw new MemoryConceptError(`memory concept path uses reserved filename ${filename}`, "RESERVED_PATH");
  }
  return input;
}

function canonicalFrontmatterValue(
  value: unknown,
  field: string,
  depth: number,
  budget: { nodes: number },
): MemoryFrontmatterValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_MEMORY_FRONTMATTER_NODES) {
    throw new MemoryConceptError(
      `frontmatter exceeds ${MAX_MEMORY_FRONTMATTER_NODES} values`,
      "INVALID_FRONTMATTER",
    );
  }
  if (depth > MAX_MEMORY_FRONTMATTER_DEPTH) {
    throw new MemoryConceptError(
      `frontmatter exceeds ${MAX_MEMORY_FRONTMATTER_DEPTH} levels`,
      "INVALID_FRONTMATTER",
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MemoryConceptError(`${field} must not contain a non-finite number`, "INVALID_FRONTMATTER");
    }
    return value;
  }
  if (typeof value === "object") {
    let isArray: boolean;
    let prototype: object | null;
    let keys: (string | symbol)[];
    const descriptors = new Map<string | symbol, PropertyDescriptor>();
    try {
      isArray = Array.isArray(value);
      prototype = Object.getPrototypeOf(value) as object | null;
      keys = Reflect.ownKeys(value);
      for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor) throw new Error("missing property descriptor");
        descriptors.set(key, descriptor);
      }
    } catch {
      throw new MemoryConceptError(
        `${field} cannot be inspected as a plain data value`,
        "INVALID_FRONTMATTER",
      );
    }

    if (isArray) {
      if (prototype !== Array.prototype) {
        throw new MemoryConceptError(`${field} must be a plain array`, "INVALID_FRONTMATTER");
      }
      const lengthDescriptor = descriptors.get("length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_MEMORY_FRONTMATTER_NODES
      ) {
        throw new MemoryConceptError(`${field} must be a bounded dense array`, "INVALID_FRONTMATTER");
      }
      const length = lengthDescriptor.value as number;
      const indices = new Map<number, PropertyDescriptor>();
      for (const key of keys) {
        if (typeof key !== "string") {
          throw new MemoryConceptError(`${field} contains a symbol key`, "INVALID_FRONTMATTER");
        }
        if (key === "length") continue;
        const descriptor = descriptors.get(key)!;
        const index = Number(key);
        if (
          !/^(?:0|[1-9][0-9]*)$/.test(key) ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new MemoryConceptError(
            `${field} must contain only enumerable data elements`,
            "INVALID_FRONTMATTER",
          );
        }
        indices.set(index, descriptor);
      }
      if (indices.size !== length) {
        throw new MemoryConceptError(`${field} must be a bounded dense array`, "INVALID_FRONTMATTER");
      }
      const output: MemoryFrontmatterValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = indices.get(index);
        if (!descriptor || !("value" in descriptor)) {
          throw new MemoryConceptError(`${field} must be a bounded dense array`, "INVALID_FRONTMATTER");
        }
        output.push(
          canonicalFrontmatterValue(descriptor.value, `${field}[${index}]`, depth + 1, budget),
        );
      }
      return output;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new MemoryConceptError(`${field} must be a plain object`, "INVALID_FRONTMATTER");
    }
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new MemoryConceptError(`${field} contains a symbol key`, "INVALID_FRONTMATTER");
      }
      const descriptor = descriptors.get(key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new MemoryConceptError(
          `${field} must contain only enumerable data properties`,
          "INVALID_FRONTMATTER",
        );
      }
      if (!key || FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new MemoryConceptError(`${field} contains forbidden key ${JSON.stringify(key)}`, "INVALID_FRONTMATTER");
      }
      if (Buffer.byteLength(key, "utf8") > MAX_MEMORY_FRONTMATTER_KEY_BYTES) {
        throw new MemoryConceptError(`${field} contains an oversized key`, "INVALID_FRONTMATTER");
      }
    }
    const output: Record<string, MemoryFrontmatterValue> = {};
    for (const key of (keys as string[]).sort(compareMemoryText)) {
      const descriptor = descriptors.get(key)!;
      output[key] = canonicalFrontmatterValue(
        descriptor.value,
        `${field}.${key}`,
        depth + 1,
        budget,
      );
    }
    return output;
  }
  throw new MemoryConceptError(`${field} contains unsupported ${typeof value}`, "INVALID_FRONTMATTER");
}

export function normalizeMemoryFrontmatter(value: unknown): MemoryConceptFrontmatter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryConceptError("memory concept frontmatter must be a mapping", "INVALID_FRONTMATTER");
  }
  const canonical = canonicalFrontmatterValue(value, "frontmatter", 0, { nodes: 0 });
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new MemoryConceptError("memory concept frontmatter must be a mapping", "INVALID_FRONTMATTER");
  }
  const type = canonical.type;
  if (typeof type !== "string" || !type.trim() || type !== type.trim()) {
    throw new MemoryConceptError('memory concept frontmatter requires a normalized non-empty "type"', "INVALID_FRONTMATTER");
  }
  for (const field of ["title", "description", "resource", "timestamp"] as const) {
    const member = canonical[field];
    if (member !== undefined && typeof member !== "string") {
      throw new MemoryConceptError(`memory concept frontmatter ${field} must be a string`, "INVALID_FRONTMATTER");
    }
  }
  if (canonical.tags !== undefined) {
    if (
      !Array.isArray(canonical.tags) ||
      canonical.tags.length > MAX_MEMORY_FRONTMATTER_TAGS ||
      canonical.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag !== tag.trim())
    ) {
      throw new MemoryConceptError("memory concept frontmatter tags must be normalized non-empty strings", "INVALID_FRONTMATTER");
    }
    if (canonical.tags.some((tag) => Buffer.byteLength(tag as string, "utf8") > MAX_MEMORY_FRONTMATTER_TAG_BYTES)) {
      throw new MemoryConceptError(
        `memory concept frontmatter tags must not exceed ${MAX_MEMORY_FRONTMATTER_TAG_BYTES} bytes`,
        "INVALID_FRONTMATTER",
      );
    }
  }
  return canonical as MemoryConceptFrontmatter;
}

function frontmatterMatch(raw: string): RegExpMatchArray {
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    throw new MemoryConceptError("memory concept must start with a closed YAML frontmatter block", "INVALID_MARKDOWN");
  }
  return match;
}

function yamlStructureOnly(value: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let comment = false;
  for (const character of value) {
    if (comment) {
      if (character === "\n") {
        comment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      output += character === "\n" ? character : " ";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += " ";
    } else if (character === "#") {
      comment = true;
      output += " ";
    } else {
      output += character;
    }
  }
  return output;
}

export function parseMemoryConcept(document: CanonicalMemoryDocument): ParsedMemoryConcept {
  const conceptPath = canonicalMemoryConceptPath(document.path);
  if (typeof document.raw !== "string") {
    throw new MemoryConceptError(`memory concept ${conceptPath} is not UTF-8 text`, "INVALID_MARKDOWN");
  }
  if (Buffer.byteLength(document.raw, "utf8") > MAX_MEMORY_CONCEPT_BYTES) {
    throw new MemoryConceptError(`memory concept exceeds ${MAX_MEMORY_CONCEPT_BYTES} bytes: ${conceptPath}`, "TOO_LARGE");
  }
  const match = frontmatterMatch(document.raw);
  if (UNSUPPORTED_YAML_FEATURE.test(yamlStructureOnly(match[1]))) {
    throw new MemoryConceptError(
      `memory concept frontmatter uses aliases, anchors, tags, or merge keys at ${conceptPath}`,
      "INVALID_FRONTMATTER",
    );
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1]);
  } catch (error) {
    throw new MemoryConceptError(
      `memory concept frontmatter is invalid YAML at ${conceptPath}: ${(error as Error).message}`,
      "INVALID_FRONTMATTER",
    );
  }
  const frontmatter = normalizeMemoryFrontmatter(parsed);
  return {
    path: conceptPath,
    raw: document.raw,
    body: document.raw.slice(match[0].length),
    frontmatter,
    contentHash: sha256(document.raw),
  };
}

function yamlScalar(value: MemoryFrontmatterValue): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlBlock(value: MemoryFrontmatterValue, indentation: number): string[] {
  const prefix = " ".repeat(indentation);
  const scalar = yamlScalar(value);
  if (scalar !== null) return [`${prefix}${scalar}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((member) => {
      const memberScalar = yamlScalar(member);
      return memberScalar !== null
        ? [`${prefix}- ${memberScalar}`]
        : [`${prefix}-`, ...yamlBlock(member, indentation + 2)];
    });
  }
  if (!value || typeof value !== "object") {
    throw new MemoryConceptError("frontmatter YAML contains an unsupported scalar", "INVALID_FRONTMATTER");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${prefix}{}`];
  return entries.flatMap(([key, member]) => {
    const memberScalar = yamlScalar(member);
    return memberScalar !== null
      ? [`${prefix}${yamlKey(key)}: ${memberScalar}`]
      : [`${prefix}${yamlKey(key)}:`, ...yamlBlock(member, indentation + 2)];
  });
}

export function serializeMemoryConcept(frontmatterInput: MemoryConceptFrontmatter, body: string): string {
  if (typeof body !== "string" || body.includes("\0")) {
    throw new MemoryConceptError("memory concept body must be UTF-8 text without NUL bytes", "INVALID_MARKDOWN");
  }
  const frontmatter = normalizeMemoryFrontmatter(frontmatterInput);
  const yaml = yamlBlock(frontmatter as unknown as MemoryFrontmatterValue, 0).join("\n");
  const normalizedBody = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const raw = `---\n${yaml}\n---\n${normalizedBody}`;
  if (Buffer.byteLength(raw, "utf8") > MAX_MEMORY_CONCEPT_BYTES) {
    throw new MemoryConceptError(`serialized memory concept exceeds ${MAX_MEMORY_CONCEPT_BYTES} bytes`, "TOO_LARGE");
  }
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/** Replace one top-level Markdown section, or append it when absent. */
export function replaceMemorySection(body: string, headingInput: string, content: string): string {
  const heading = headingInput.replace(/^#+\s*/, "").trim();
  if (!heading || /[\r\n\0]/.test(heading)) {
    throw new MemoryConceptError("replacement heading must be one non-empty line", "INVALID_MARKDOWN");
  }
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const start = lines.findIndex(
    (line) => /^#\s+/.test(line) && line.replace(/^#\s+/, "").trim() === heading,
  );
  if (start === -1) {
    const prefix = body.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}# ${heading}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? `\n${after}` : ""}`;
}

export function assertSha256(value: string, field: string): string {
  if (!SHA256.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}
