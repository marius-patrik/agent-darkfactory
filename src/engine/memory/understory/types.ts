// Derived from Understory at 912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2.
// Copyright 2026 Anirban Kar. Modified by Andromeda contributors.
// Licensed under the Apache License, Version 2.0.

export type MemoryFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | MemoryFrontmatterValue[]
  | { [key: string]: MemoryFrontmatterValue };

/** OKF frontmatter. Unknown producer-owned fields are retained after validation. */
export interface MemoryConceptFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  [key: string]: MemoryFrontmatterValue | undefined;
}

/** One Markdown document supplied by the canonical private-data state service. */
export interface CanonicalMemoryDocument {
  /** Portable bundle path, for example `/concepts/andromeda.md`. */
  path: string;
  /** Exact authoritative Markdown bytes decoded as UTF-8. */
  raw: string;
}

export interface CanonicalMemorySnapshot {
  /** Opaque optimistic revision supplied by the state service, normally a Git commit. */
  revision: string;
  documents: readonly CanonicalMemoryDocument[];
}

export interface ParsedMemoryConcept extends CanonicalMemoryDocument {
  frontmatter: MemoryConceptFrontmatter;
  body: string;
  contentHash: string;
}

export interface MemorySearchOptions {
  type?: string;
  tags?: readonly string[];
  limit?: number;
}

export interface MemorySearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  snippet?: string;
  score: number;
}

export interface MemoryGraphNode {
  path: string;
  type: string;
  title?: string;
  description?: string;
  links: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
}

export interface MemoryBrokenLink {
  path: string;
  target: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  brokenLinks: MemoryBrokenLink[];
}

export interface MemoryValidationIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface MemoryValidationReport {
  conformant: boolean;
  conceptCount: number;
  issues: MemoryValidationIssue[];
}

export interface CanonicalMemoryEvidence {
  uri: string;
  contentHash: string;
}

export type CanonicalMemoryTransactionMutation =
  | {
      type: "put";
      path: string;
      raw: string;
      /** `null` means that the concept must not already exist. */
      expectedContentHash: string | null;
    }
  | {
      type: "delete";
      path: string;
      expectedContentHash: string;
    };
export interface CanonicalMemoryTransaction {
  baseRevision: string;
  actor: string;
  evidence: CanonicalMemoryEvidence;
  mutations: readonly CanonicalMemoryTransactionMutation[];
}

/**
 * The canonical state service is the sole implementation of this interface.
 * The Understory-derived engine never writes private-data or Git directly.
 */
export interface CanonicalMemoryAuthority {
  readSnapshot(): Promise<CanonicalMemorySnapshot>;
  /** Return the immutable snapshot created by this exact transaction. */
  transact(transaction: CanonicalMemoryTransaction): Promise<CanonicalMemorySnapshot>;
}

export type MemoryUpdate =
  | {
      type: "put";
      path: string;
      frontmatter: MemoryConceptFrontmatter;
      body: string;
      expectedContentHash: string | null;
    }
  | {
      type: "patch";
      path: string;
      expectedContentHash: string;
      frontmatter?: Record<string, MemoryFrontmatterValue | null>;
      replaceBody?: string;
      replaceSection?: { heading: string; content: string };
    }
  | {
      type: "delete";
      path: string;
      expectedContentHash: string;
    };
