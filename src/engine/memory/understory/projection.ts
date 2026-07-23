// Derived from Understory at 912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2.
// Copyright 2026 Anirban Kar. Modified by Andromeda contributors.
// Licensed under the Apache License, Version 2.0.

import { Database } from "bun:sqlite";
import {
  canonicalMemoryConceptPath,
  compareMemoryText,
  parseMemoryConcept,
  sha256,
} from "./okf";
import type {
  CanonicalMemorySnapshot,
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryValidationIssue,
  MemoryValidationReport,
  ParsedMemoryConcept,
} from "./types";

const PROJECTION_SCHEMA_VERSION = 1;
const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;
const MAX_SNAPSHOT_CONCEPTS = 50_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_SNAPSHOT_REVISION_BYTES = 4 * 1024;
const MAX_SEARCH_QUERY_BYTES = 16 * 1024;
const MAX_SEARCH_TERMS = 64;
const MAX_SEARCH_TERM_BYTES = 256;
const MAX_SEARCH_FILTER_BYTES = 512;
const MAX_SEARCH_TAGS = 128;

interface StoredConcept {
  path: string;
  type: string;
  title: string | null;
  description: string | null;
  tags_json: string;
  body: string;
  raw: string;
  content_hash: string;
}

function requiredRevision(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error("canonical memory snapshot revision is required and must be one line");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_REVISION_BYTES) {
    throw new Error(`canonical memory snapshot revision exceeds ${MAX_SNAPSHOT_REVISION_BYTES} bytes`);
  }
  return value;
}

export function parseCanonicalMemorySnapshot(snapshot: CanonicalMemorySnapshot): ParsedMemoryConcept[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("canonical memory snapshot must be an object");
  }
  requiredRevision(snapshot.revision);
  if (!Array.isArray(snapshot.documents)) throw new Error("canonical memory snapshot documents must be an array");
  if (snapshot.documents.length > MAX_SNAPSHOT_CONCEPTS) {
    throw new Error(`canonical memory snapshot exceeds ${MAX_SNAPSHOT_CONCEPTS} concepts`);
  }
  let aggregateBytes = 0;
  for (const document of snapshot.documents) {
    if (!document || typeof document !== "object" || typeof document.raw !== "string") {
      throw new Error("canonical memory snapshot contains a non-text document");
    }
    aggregateBytes += Buffer.byteLength(document.raw, "utf8");
    if (aggregateBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`canonical memory snapshot exceeds ${MAX_SNAPSHOT_BYTES} aggregate bytes`);
    }
  }
  const concepts = snapshot.documents
    .map(parseMemoryConcept)
    .sort((left, right) => compareMemoryText(left.path, right.path));
  for (let index = 1; index < concepts.length; index += 1) {
    if (concepts[index - 1].path === concepts[index].path) {
      throw new Error(`canonical memory snapshot repeats concept path ${concepts[index].path}`);
    }
  }
  return concepts;
}

function projectionDigest(snapshot: CanonicalMemorySnapshot, concepts: readonly ParsedMemoryConcept[]): string {
  return sha256(
    JSON.stringify({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      revision: requiredRevision(snapshot.revision),
      concepts: concepts.map(({ path, contentHash }) => ({ path, contentHash })),
    }),
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function tags(concept: ParsedMemoryConcept): string[] {
  return Array.isArray(concept.frontmatter.tags)
    ? concept.frontmatter.tags.map(String)
    : [];
}

function graphRows(concepts: readonly ParsedMemoryConcept[]): {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  brokenLinks: { path: string; target: string }[];
} {
  const known = new Set(concepts.map((concept) => concept.path));
  const degrees = new Map(concepts.map((concept) => [concept.path, 0]));
  const edges: MemoryGraphEdge[] = [];
  const brokenLinks: { path: string; target: string }[] = [];
  for (const concept of concepts) {
    const targets = new Set<string>();
    for (const match of concept.body.matchAll(LINK_RE)) {
      let target: string;
      try {
        target = canonicalMemoryConceptPath(match[1]);
      } catch {
        brokenLinks.push({ path: concept.path, target: match[1] });
        continue;
      }
      if (target === concept.path || targets.has(target)) continue;
      targets.add(target);
      if (known.has(target)) {
        edges.push({ source: concept.path, target });
        degrees.set(concept.path, (degrees.get(concept.path) ?? 0) + 1);
        degrees.set(target, (degrees.get(target) ?? 0) + 1);
      } else {
        brokenLinks.push({ path: concept.path, target });
      }
    }
  }
  edges.sort(
    (left, right) =>
      compareMemoryText(left.source, right.source) || compareMemoryText(left.target, right.target),
  );
  brokenLinks.sort(
    (left, right) =>
      compareMemoryText(left.path, right.path) || compareMemoryText(left.target, right.target),
  );
  const nodes = concepts.map((concept) => ({
    path: concept.path,
    type: concept.frontmatter.type,
    ...(text(concept.frontmatter.title) ? { title: text(concept.frontmatter.title) } : {}),
    ...(text(concept.frontmatter.description) ? { description: text(concept.frontmatter.description) } : {}),
    links: degrees.get(concept.path) ?? 0,
  }));
  return { nodes, edges, brokenLinks };
}

function queryTerms(query: string): string[] {
  if (typeof query !== "string" || query.includes("\0")) {
    throw new Error("memory search query must be a string without NUL bytes");
  }
  if (Buffer.byteLength(query, "utf8") > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`memory search query exceeds ${MAX_SEARCH_QUERY_BYTES} bytes`);
  }
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1);
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new Error(`memory search query exceeds ${MAX_SEARCH_TERMS} terms`);
  }
  if (terms.some((term) => Buffer.byteLength(term, "utf8") > MAX_SEARCH_TERM_BYTES)) {
    throw new Error(`memory search term exceeds ${MAX_SEARCH_TERM_BYTES} bytes`);
  }
  return terms;
}

function ftsExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function searchScore(concept: StoredConcept, terms: readonly string[]): { score: number; bodyIndex: number } {
  if (terms.length === 0) return { score: 1, bodyIndex: -1 };
  const title = (concept.title ?? "").toLowerCase();
  const description = (concept.description ?? "").toLowerCase();
  const tagText = (JSON.parse(concept.tags_json) as string[]).join(" ").toLowerCase();
  const body = concept.body.toLowerCase();
  const conceptPath = concept.path.toLowerCase();
  let score = 0;
  let bodyIndex = -1;
  for (const term of terms) {
    if (title.includes(term)) score += 10;
    if (conceptPath.includes(term)) score += 6;
    if (description.includes(term)) score += 5;
    if (tagText.includes(term)) score += 5;
    const index = body.indexOf(term);
    if (index >= 0) {
      score += 2;
      if (bodyIndex < 0 || index < bodyIndex) bodyIndex = index;
    }
  }
  return { score, bodyIndex };
}

function searchOptions(options: MemorySearchOptions | undefined): {
  type?: string;
  tags: string[];
  limit: number;
} {
  if (options === undefined) return { tags: [], limit: 20 };
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("memory search options must be an object");
  }
  let type: string | undefined;
  if (options.type !== undefined) {
    if (
      typeof options.type !== "string" ||
      Buffer.byteLength(options.type, "utf8") > MAX_SEARCH_FILTER_BYTES ||
      !options.type.trim() ||
      options.type !== options.type.trim()
    ) {
      throw new Error(`memory search type must be normalized and at most ${MAX_SEARCH_FILTER_BYTES} bytes`);
    }
    type = options.type.toLowerCase();
  }
  const inputTags = options.tags ?? [];
  if (!Array.isArray(inputTags) || inputTags.length > MAX_SEARCH_TAGS) {
    throw new Error(`memory search tags must be an array of at most ${MAX_SEARCH_TAGS} entries`);
  }
  const tags = inputTags.map((tag) => {
    if (
      typeof tag !== "string" ||
      Buffer.byteLength(tag, "utf8") > MAX_SEARCH_FILTER_BYTES ||
      !tag.trim() ||
      tag !== tag.trim()
    ) {
      throw new Error(`memory search tag must be normalized and at most ${MAX_SEARCH_FILTER_BYTES} bytes`);
    }
    return tag.toLowerCase();
  });
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("memory search limit must be an integer between 1 and 1000");
  }
  return { ...(type ? { type } : {}), tags, limit };
}

export function validateMemorySearchInput(query: string, options?: MemorySearchOptions): void {
  queryTerms(query);
  searchOptions(options);
}

/**
 * Rebuildable SQLite/FTS/graph projection. The database contains no authority:
 * every row and metadata value is regenerated solely from a canonical snapshot.
 */
export class UnderstoryMemoryProjection {
  private readonly database: Database;

  constructor(databasePath = ":memory:") {
    this.database = new Database(databasePath, { create: true, strict: true });
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  close(): void {
    this.database.close();
  }

  metadata(): { revision: string; digest: string; conceptCount: number } | null {
    const table = this.database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'projection_meta'")
      .get() as { present: number } | null;
    if (!table) return null;
    const rows = this.database.query("SELECT key, value FROM projection_meta").all() as { key: string; value: string }[];
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    if (!values.revision || !values.digest || values.concept_count === undefined) return null;
    return { revision: values.revision, digest: values.digest, conceptCount: Number(values.concept_count) };
  }

  rebuild(snapshot: CanonicalMemorySnapshot): { revision: string; digest: string; conceptCount: number } {
    const concepts = parseCanonicalMemorySnapshot(snapshot);
    const digest = projectionDigest(snapshot, concepts);
    const graph = graphRows(concepts);
    const rebuild = this.database.transaction(() => {
      this.database.exec(`
        DROP TABLE IF EXISTS concept_fts;
        DROP TABLE IF EXISTS broken_links;
        DROP TABLE IF EXISTS links;
        DROP TABLE IF EXISTS concepts;
        DROP TABLE IF EXISTS projection_meta;
        CREATE TABLE projection_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE concepts (
          path TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          title TEXT,
          description TEXT,
          tags_json TEXT NOT NULL,
          body TEXT NOT NULL,
          raw TEXT NOT NULL,
          content_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE links (
          source TEXT NOT NULL REFERENCES concepts(path) ON DELETE CASCADE,
          target TEXT NOT NULL REFERENCES concepts(path) ON DELETE CASCADE,
          PRIMARY KEY (source, target)
        ) STRICT;
        CREATE TABLE broken_links (
          source TEXT NOT NULL REFERENCES concepts(path) ON DELETE CASCADE,
          target TEXT NOT NULL,
          PRIMARY KEY (source, target)
        ) STRICT;
        CREATE VIRTUAL TABLE concept_fts USING fts5(
          path,
          title,
          description,
          tags,
          body,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
      const insertConcept = this.database.prepare(
        "INSERT INTO concepts(path, type, title, description, tags_json, body, raw, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = this.database.prepare(
        "INSERT INTO concept_fts(path, title, description, tags, body) VALUES (?, ?, ?, ?, ?)",
      );
      for (const concept of concepts) {
        const conceptTags = tags(concept);
        const title = text(concept.frontmatter.title) ?? null;
        const description = text(concept.frontmatter.description) ?? null;
        insertConcept.run(
          concept.path,
          concept.frontmatter.type,
          title,
          description,
          JSON.stringify(conceptTags),
          concept.body,
          concept.raw,
          concept.contentHash,
        );
        insertFts.run(concept.path, title ?? "", description ?? "", conceptTags.join(" "), concept.body);
      }
      const insertLink = this.database.prepare("INSERT INTO links(source, target) VALUES (?, ?)");
      for (const edge of graph.edges) insertLink.run(edge.source, edge.target);
      const insertBroken = this.database.prepare("INSERT INTO broken_links(source, target) VALUES (?, ?)");
      for (const broken of graph.brokenLinks) insertBroken.run(broken.path, broken.target);
      const insertMeta = this.database.prepare("INSERT INTO projection_meta(key, value) VALUES (?, ?)");
      insertMeta.run("schema_version", String(PROJECTION_SCHEMA_VERSION));
      insertMeta.run("revision", snapshot.revision);
      insertMeta.run("digest", digest);
      insertMeta.run("concept_count", String(concepts.length));
    });
    rebuild();
    return { revision: snapshot.revision, digest, conceptCount: concepts.length };
  }

  ensure(snapshot: CanonicalMemorySnapshot): { revision: string; digest: string; conceptCount: number } {
    const concepts = parseCanonicalMemorySnapshot(snapshot);
    const expectedDigest = projectionDigest(snapshot, concepts);
    const current = this.metadata();
    if (
      current?.revision === snapshot.revision &&
      current.digest === expectedDigest &&
      current.conceptCount === concepts.length
    ) {
      const stored = this.database
        .query("SELECT path, raw, content_hash FROM concepts ORDER BY path")
        .all() as { path: string; raw: string; content_hash: string }[];
      if (
        stored.length === concepts.length &&
        stored.every(
          (entry, index) =>
            entry.path === concepts[index].path &&
            entry.raw === concepts[index].raw &&
            entry.content_hash === concepts[index].contentHash &&
            sha256(entry.raw) === entry.content_hash,
        )
      ) {
        return current;
      }
    }
    return this.rebuild(snapshot);
  }

  read(conceptPath: string): ParsedMemoryConcept | null {
    const row = this.database
      .query("SELECT path, raw FROM concepts WHERE path = ?")
      .get(canonicalMemoryConceptPath(conceptPath)) as { path: string; raw: string } | null;
    return row ? parseMemoryConcept(row) : null;
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
    const terms = queryTerms(query);
    const filters = searchOptions(options);
    const rows =
      terms.length === 0
        ? (this.database.query("SELECT * FROM concepts ORDER BY path").all() as StoredConcept[])
        : (this.database
            .query(
              "SELECT concepts.* FROM concept_fts JOIN concepts ON concepts.path = concept_fts.path WHERE concept_fts MATCH ? ORDER BY concepts.path",
            )
            .all(ftsExpression(terms)) as StoredConcept[]);
    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      if (filters.type && row.type.toLowerCase() !== filters.type) continue;
      const rowTags = (JSON.parse(row.tags_json) as string[]).map((tag) => tag.toLowerCase());
      if (filters.tags.some((tag) => !rowTags.includes(tag))) continue;
      const { score, bodyIndex } = searchScore(row, terms);
      if (score === 0) continue;
      hits.push({
        path: row.path,
        type: row.type,
        ...(row.title ? { title: row.title } : {}),
        ...(row.description ? { description: row.description } : {}),
        ...(bodyIndex >= 0
          ? {
              snippet: row.body
                .slice(Math.max(0, bodyIndex - 60), bodyIndex + 120)
                .replace(/\s+/g, " ")
                .trim(),
            }
          : {}),
        score,
      });
    }
    hits.sort((left, right) => right.score - left.score || compareMemoryText(left.path, right.path));
    return hits.slice(0, filters.limit);
  }

  listTypes(): string[] {
    return (this.database.query("SELECT DISTINCT type FROM concepts ORDER BY type").all() as { type: string }[]).map(
      (row) => row.type,
    );
  }

  graph(): MemoryGraph {
    const stored = this.database.query("SELECT * FROM concepts ORDER BY path").all() as StoredConcept[];
    const edges = this.database.query("SELECT source, target FROM links ORDER BY source, target").all() as MemoryGraphEdge[];
    const brokenLinks = this.database
      .query("SELECT source AS path, target FROM broken_links ORDER BY source, target")
      .all() as { path: string; target: string }[];
    const degree = new Map(stored.map((concept) => [concept.path, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    return {
      nodes: stored.map((concept) => ({
        path: concept.path,
        type: concept.type,
        ...(concept.title ? { title: concept.title } : {}),
        ...(concept.description ? { description: concept.description } : {}),
        links: degree.get(concept.path) ?? 0,
      })),
      edges,
      brokenLinks,
    };
  }

  validate(): MemoryValidationReport {
    const concepts = this.database.query("SELECT * FROM concepts ORDER BY path").all() as StoredConcept[];
    const issues: MemoryValidationIssue[] = [];
    for (const concept of concepts) {
      if (!concept.title) {
        issues.push({ path: concept.path, severity: "warning", message: 'Missing recommended "title" field' });
      }
      if (!concept.description) {
        issues.push({ path: concept.path, severity: "warning", message: 'Missing recommended "description" field' });
      }
    }
    for (const broken of this.graph().brokenLinks) {
      issues.push({
        path: broken.path,
        severity: "warning",
        message: `Broken bundle-relative link: ${broken.target}`,
      });
    }
    return { conformant: true, conceptCount: concepts.length, issues };
  }
}
