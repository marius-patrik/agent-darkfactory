// Derived from Understory at 912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2.
// Copyright 2026 Anirban Kar. Modified by Andromeda contributors.
// Licensed under the Apache License, Version 2.0.

import {
  assertSha256,
  canonicalMemoryConceptPath,
  normalizeMemoryFrontmatter,
  parseMemoryConcept,
  replaceMemorySection,
  serializeMemoryConcept,
} from "./okf";
import {
  UnderstoryMemoryProjection,
  parseCanonicalMemorySnapshot,
  validateMemorySearchInput,
} from "./projection";
import type {
  CanonicalMemoryAuthority,
  CanonicalMemoryDocument,
  CanonicalMemoryEvidence,
  CanonicalMemorySnapshot,
  CanonicalMemoryTransactionMutation,
  MemoryConceptFrontmatter,
  MemoryFrontmatterValue,
  MemoryGraph,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryUpdate,
  MemoryValidationReport,
  ParsedMemoryConcept,
} from "./types";

const MAX_MEMORY_TRANSACTION_UPDATES = 1_000;
const MAX_MEMORY_ACTOR_BYTES = 512;
const MAX_MEMORY_EVIDENCE_URI_BYTES = 8 * 1024;
const FORBIDDEN_MEMORY_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type RuntimeRecord = Record<string, unknown>;

function strictRuntimeRecord(value: unknown, field: string): RuntimeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a plain object`);
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${field} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object`);
  }
  for (const key of keys) {
    if (typeof key !== "string") throw new Error(`${field} must not contain symbol keys`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${field} must contain only enumerable data properties`);
    }
  }
  return value as RuntimeRecord;
}

function runtimeKeys(record: RuntimeRecord): string[] {
  return Reflect.ownKeys(record) as string[];
}

function requiredRuntimeField(record: RuntimeRecord, key: string, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`${field} requires ${key}`);
  }
  return record[key];
}

function rejectUnknownRuntimeFields(
  record: RuntimeRecord,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of runtimeKeys(record)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unsupported field ${JSON.stringify(key)}`);
  }
}

function runtimeString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function runtimeContentHash(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return assertSha256(value, field);
}

function normalizedFrontmatterPatch(
  value: unknown,
  field: string,
): Record<string, MemoryFrontmatterValue | null> {
  const patch = strictRuntimeRecord(value, field);
  const validationCandidate: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  validationCandidate.type = "__andromeda_patch_validation__";
  for (const key of runtimeKeys(patch)) {
    if (!key || FORBIDDEN_MEMORY_PATCH_KEYS.has(key)) {
      throw new Error(`${field} contains forbidden key ${JSON.stringify(key)}`);
    }
    const member = patch[key];
    if (key === "type" && member === null) {
      throw new Error(`${field} cannot delete required field "type"`);
    }
    if (member !== null) validationCandidate[key] = member;
  }
  const normalized = normalizeMemoryFrontmatter(validationCandidate);
  const result: Record<string, MemoryFrontmatterValue | null> = Object.create(null) as Record<
    string,
    MemoryFrontmatterValue | null
  >;
  for (const key of runtimeKeys(patch)) {
    result[key] = patch[key] === null ? null : (normalized[key] as MemoryFrontmatterValue);
  }
  return result;
}

function validateMemoryUpdate(value: unknown, index: number): MemoryUpdate {
  const field = `memory update at index ${index}`;
  const update = strictRuntimeRecord(value, field);
  const type = requiredRuntimeField(update, "type", field);
  if (typeof type !== "string") throw new Error(`${field} type must be a string`);
  if (type !== "put" && type !== "patch" && type !== "delete") {
    throw new Error(`${field} has unsupported type ${JSON.stringify(type)}`);
  }
  const path = canonicalMemoryConceptPath(
    runtimeString(requiredRuntimeField(update, "path", field), `${field} path`),
  );

  if (type === "put") {
    rejectUnknownRuntimeFields(
      update,
      new Set(["type", "path", "frontmatter", "body", "expectedContentHash"]),
      field,
    );
    const frontmatterValue = requiredRuntimeField(update, "frontmatter", field);
    strictRuntimeRecord(frontmatterValue, `${field} frontmatter`);
    const frontmatter = normalizeMemoryFrontmatter(frontmatterValue);
    const body = runtimeString(requiredRuntimeField(update, "body", field), `${field} body`);
    const expectedValue = requiredRuntimeField(update, "expectedContentHash", field);
    const expectedContentHash =
      expectedValue === null
        ? null
        : runtimeContentHash(expectedValue, `${field} expectedContentHash`);
    // Preflight the complete replacement before any candidate snapshot is changed.
    serializeMemoryConcept(frontmatter, body);
    return { type, path, frontmatter, body, expectedContentHash };
  }

  if (type === "patch") {
    rejectUnknownRuntimeFields(
      update,
      new Set([
        "type",
        "path",
        "expectedContentHash",
        "frontmatter",
        "replaceBody",
        "replaceSection",
      ]),
      field,
    );
    const expectedContentHash = runtimeContentHash(
      requiredRuntimeField(update, "expectedContentHash", field),
      `${field} expectedContentHash`,
    );
    const frontmatter = Object.prototype.hasOwnProperty.call(update, "frontmatter")
      ? normalizedFrontmatterPatch(update.frontmatter, `${field} frontmatter`)
      : undefined;
    const replaceBody = Object.prototype.hasOwnProperty.call(update, "replaceBody")
      ? runtimeString(update.replaceBody, `${field} replaceBody`)
      : undefined;
    let replaceSection: { heading: string; content: string } | undefined;
    if (Object.prototype.hasOwnProperty.call(update, "replaceSection")) {
      const section = strictRuntimeRecord(update.replaceSection, `${field} replaceSection`);
      rejectUnknownRuntimeFields(section, new Set(["heading", "content"]), `${field} replaceSection`);
      replaceSection = {
        heading: runtimeString(
          requiredRuntimeField(section, "heading", `${field} replaceSection`),
          `${field} replaceSection heading`,
        ),
        content: runtimeString(
          requiredRuntimeField(section, "content", `${field} replaceSection`),
          `${field} replaceSection content`,
        ),
      };
      replaceMemorySection("", replaceSection.heading, replaceSection.content);
    }
    if (replaceBody !== undefined && replaceSection !== undefined) {
      throw new Error("memory patch cannot replace the full body and one section together");
    }
    return {
      type,
      path,
      expectedContentHash,
      ...(frontmatter ? { frontmatter } : {}),
      ...(replaceBody !== undefined ? { replaceBody } : {}),
      ...(replaceSection ? { replaceSection } : {}),
    };
  }

  if (type === "delete") {
    rejectUnknownRuntimeFields(update, new Set(["type", "path", "expectedContentHash"]), field);
    return {
      type,
      path,
      expectedContentHash: runtimeContentHash(
        requiredRuntimeField(update, "expectedContentHash", field),
        `${field} expectedContentHash`,
      ),
    };
  }
  throw new Error(`${field} has unsupported type ${JSON.stringify(type)}`);
}

function validateMemoryUpdates(value: unknown): MemoryUpdate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("memory transaction requires at least one update");
  }
  if (value.length > MAX_MEMORY_TRANSACTION_UPDATES) {
    throw new Error(`memory transaction exceeds ${MAX_MEMORY_TRANSACTION_UPDATES} updates`);
  }
  return value.map(validateMemoryUpdate);
}

function requiredOneLine(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required and must be one normalized line`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
  if (!value.trim() || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${field} is required and must be one normalized line`);
  }
  return value;
}

function validateEvidence(evidence: CanonicalMemoryEvidence): CanonicalMemoryEvidence {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("memory transaction evidence must be an object");
  }
  const uri = requiredOneLine(
    evidence.uri,
    "memory transaction evidence URI",
    MAX_MEMORY_EVIDENCE_URI_BYTES,
  );
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("memory transaction evidence URI must be absolute");
  }
  if (!parsed.protocol) throw new Error("memory transaction evidence URI must include a scheme");
  return {
    uri,
    contentHash: assertSha256(evidence.contentHash, "memory transaction evidence hash"),
  };
}

function documentMap(snapshot: CanonicalMemorySnapshot): Map<string, CanonicalMemoryDocument> {
  const documents = new Map<string, CanonicalMemoryDocument>();
  for (const parsed of parseCanonicalMemorySnapshot(snapshot)) {
    if (documents.has(parsed.path)) throw new Error(`canonical memory repeats path ${parsed.path}`);
    documents.set(parsed.path, { path: parsed.path, raw: parsed.raw });
  }
  return documents;
}

function applyFrontmatterPatch(
  source: ParsedMemoryConcept["frontmatter"],
  patch: Record<string, MemoryFrontmatterValue | null> | undefined,
): ParsedMemoryConcept["frontmatter"] {
  if (!patch) return source;
  const next = Object.assign(Object.create(null) as MemoryConceptFrontmatter, source);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function transactionMutations(
  snapshot: CanonicalMemorySnapshot,
  updates: readonly MemoryUpdate[],
): CanonicalMemoryTransactionMutation[] {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("memory transaction requires at least one update");
  }
  if (updates.length > MAX_MEMORY_TRANSACTION_UPDATES) {
    throw new Error(`memory transaction exceeds ${MAX_MEMORY_TRANSACTION_UPDATES} updates`);
  }
  const documents = documentMap(snapshot);
  const touched = new Set<string>();
  const mutations: CanonicalMemoryTransactionMutation[] = [];
  for (const update of updates) {
    const conceptPath = canonicalMemoryConceptPath(update.path);
    if (touched.has(conceptPath)) throw new Error(`memory transaction repeats path ${conceptPath}`);
    touched.add(conceptPath);
    const currentDocument = documents.get(conceptPath);
    const current = currentDocument ? parseMemoryConcept(currentDocument) : null;
    if (update.type === "put") {
      if (update.expectedContentHash === null) {
        if (current) throw new Error(`memory concept already exists: ${conceptPath}`);
      } else {
        assertSha256(update.expectedContentHash, "expected memory content hash");
        if (!current || current.contentHash !== update.expectedContentHash) {
          throw new Error(`memory concept content changed before update: ${conceptPath}`);
        }
      }
      const raw = serializeMemoryConcept(update.frontmatter, update.body);
      parseMemoryConcept({ path: conceptPath, raw });
      mutations.push({
        type: "put",
        path: conceptPath,
        raw,
        expectedContentHash: update.expectedContentHash,
      });
      documents.set(conceptPath, { path: conceptPath, raw });
      continue;
    }
    if (!current || current.contentHash !== assertSha256(update.expectedContentHash, "expected memory content hash")) {
      throw new Error(`memory concept content changed before ${update.type}: ${conceptPath}`);
    }
    if (update.type === "delete") {
      mutations.push({
        type: "delete",
        path: conceptPath,
        expectedContentHash: update.expectedContentHash,
      });
      documents.delete(conceptPath);
      continue;
    }
    if (update.replaceBody !== undefined && update.replaceSection !== undefined) {
      throw new Error("memory patch cannot replace the full body and one section together");
    }
    const body =
      update.replaceBody ??
      (update.replaceSection
        ? replaceMemorySection(current.body, update.replaceSection.heading, update.replaceSection.content)
        : current.body);
    const raw = serializeMemoryConcept(applyFrontmatterPatch(current.frontmatter, update.frontmatter), body);
    parseMemoryConcept({ path: conceptPath, raw });
    mutations.push({
      type: "put",
      path: conceptPath,
      raw,
      expectedContentHash: update.expectedContentHash,
    });
    documents.set(conceptPath, { path: conceptPath, raw });
  }
  // Validate the complete candidate snapshot before the state authority sees a mutation.
  for (const document of documents.values()) parseMemoryConcept(document);
  return mutations;
}

function assertCommitted(
  before: CanonicalMemorySnapshot,
  after: CanonicalMemorySnapshot,
  mutations: readonly CanonicalMemoryTransactionMutation[],
): void {
  const expected = documentMap(before);
  for (const mutation of mutations) {
    if (mutation.type === "delete") expected.delete(mutation.path);
    else expected.set(mutation.path, { path: mutation.path, raw: mutation.raw });
  }
  const committed = documentMap(after);
  if (committed.size !== expected.size) {
    throw new Error(
      `canonical memory authority published ${committed.size} concepts; expected ${expected.size}`,
    );
  }
  for (const [conceptPath, document] of expected) {
    if (committed.get(conceptPath)?.raw !== document.raw) {
      throw new Error(`canonical memory authority did not publish exact snapshot bytes for ${conceptPath}`);
    }
  }
}

/**
 * Query/update boundary for the built-in Memory plugin.
 *
 * Every mutation crosses CanonicalMemoryAuthority with an optimistic base
 * revision. SQLite and graph state are refreshed only from the committed
 * Markdown snapshot, never from the caller's candidate.
 */
export class UnderstoryMemoryService {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly authority: CanonicalMemoryAuthority,
    private readonly projection: UnderstoryMemoryProjection,
  ) {}

  private exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshProjection(): Promise<{ revision: string; digest: string; conceptCount: number }> {
    return this.projection.ensure(await this.authority.readSnapshot());
  }

  refresh(): Promise<{ revision: string; digest: string; conceptCount: number }> {
    return this.exclusively(() => this.refreshProjection());
  }

  read(conceptPath: string): Promise<ParsedMemoryConcept | null> {
    const canonicalPath = canonicalMemoryConceptPath(conceptPath);
    return this.exclusively(async () => {
      await this.refreshProjection();
      return this.projection.read(canonicalPath);
    });
  }

  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
    validateMemorySearchInput(query, options);
    return this.exclusively(async () => {
      await this.refreshProjection();
      return this.projection.search(query, options);
    });
  }

  graph(): Promise<MemoryGraph> {
    return this.exclusively(async () => {
      await this.refreshProjection();
      return this.projection.graph();
    });
  }

  validate(): Promise<MemoryValidationReport> {
    return this.exclusively(async () => {
      await this.refreshProjection();
      return this.projection.validate();
    });
  }

  update(
    updates: readonly MemoryUpdate[],
    options: { actor: string; evidence: CanonicalMemoryEvidence },
  ): Promise<{ revision: string; digest: string; conceptCount: number }> {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("memory transaction options must be an object");
    }
    const actor = requiredOneLine(options.actor, "memory transaction actor", MAX_MEMORY_ACTOR_BYTES);
    const evidence = validateEvidence(options.evidence);
    const validatedUpdates = validateMemoryUpdates(updates);
    return this.exclusively(async () => {
      const before = await this.authority.readSnapshot();
      const mutations = transactionMutations(before, validatedUpdates);
      const committed = await this.authority.transact({
        baseRevision: before.revision,
        actor,
        evidence,
        mutations,
      });
      assertCommitted(before, committed, mutations);
      return this.projection.rebuild(committed);
    });
  }
}
