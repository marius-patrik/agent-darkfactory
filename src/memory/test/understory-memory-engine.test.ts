import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  UnderstoryMemoryProjection,
  UnderstoryMemoryService,
  compareMemoryText,
  parseMemoryConcept,
  planMemoryMigration,
  serializeMemoryConcept,
  type CanonicalMemoryAuthority,
  type CanonicalMemoryDocument,
  type CanonicalMemorySnapshot,
  type CanonicalMemoryTransaction,
  type LegacyMemorySource,
} from "../../engine/memory";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function concept(
  path: string,
  type: string,
  title: string,
  body: string,
  options: { description?: string; tags?: string[] } = {},
): CanonicalMemoryDocument {
  return {
    path,
    raw: serializeMemoryConcept(
      {
        type,
        title,
        ...(options.description ? { description: options.description } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
      },
      body,
    ),
  };
}

class FakeCanonicalMemoryAuthority implements CanonicalMemoryAuthority {
  snapshot: CanonicalMemorySnapshot;
  transactions: CanonicalMemoryTransaction[] = [];
  rejectNextTransaction = false;
  publishLaterCommitAfterTransaction = false;
  readCalls = 0;
  activeReads = 0;
  maxConcurrentReads = 0;
  readSnapshotHook?: (call: number, captured: CanonicalMemorySnapshot) => Promise<void>;

  constructor(documents: CanonicalMemoryDocument[]) {
    this.snapshot = { revision: "commit-1", documents };
  }

  async readSnapshot(): Promise<CanonicalMemorySnapshot> {
    const captured = {
      revision: this.snapshot.revision,
      documents: this.snapshot.documents.map((document) => ({ ...document })),
    };
    this.readCalls += 1;
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    try {
      await this.readSnapshotHook?.(this.readCalls, captured);
      return captured;
    } finally {
      this.activeReads -= 1;
    }
  }

  async transact(transaction: CanonicalMemoryTransaction): Promise<CanonicalMemorySnapshot> {
    this.transactions.push(structuredClone(transaction));
    if (this.rejectNextTransaction) {
      this.rejectNextTransaction = false;
      this.snapshot = { ...this.snapshot, revision: "concurrent-commit" };
      throw new Error("optimistic base commit is stale");
    }
    if (transaction.baseRevision !== this.snapshot.revision) throw new Error("optimistic base commit is stale");
    const documents = new Map(this.snapshot.documents.map((document) => [document.path, { ...document }]));
    for (const mutation of transaction.mutations) {
      const existing = documents.get(mutation.path);
      const existingHash = existing ? hash(existing.raw) : null;
      if (existingHash !== mutation.expectedContentHash) throw new Error(`content hash mismatch at ${mutation.path}`);
      if (mutation.type === "delete") documents.delete(mutation.path);
      else documents.set(mutation.path, { path: mutation.path, raw: mutation.raw });
    }
    const revision = `commit-${this.transactions.length + 1}`;
    this.snapshot = {
      revision,
      documents: [...documents.values()].sort((left, right) => compareMemoryText(left.path, right.path)),
    };
    const committed = await this.readSnapshot();
    if (this.publishLaterCommitAfterTransaction) {
      this.snapshot = {
        revision: "commit-later",
        documents: [
          ...committed.documents,
          concept("/concepts/later.md", "fact", "Later", "A second writer committed immediately.\n"),
        ],
      };
    }
    return committed;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("test condition did not become true");
}

describe("Understory-derived canonical memory boundary", () => {
  test("primary path: query, graph, and update use one canonical Markdown authority", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept(
        "/concepts/andromeda.md",
        "system",
        "Andromeda",
        "The engine links to [AMS](/concepts/ams.md).\n",
        { description: "Unified agent product", tags: ["agent", "runtime"] },
      ),
      concept(
        "/concepts/ams.md",
        "model-runtime",
        "AMS",
        "Sparse local inference runtime.\n",
        { description: "Local model runtime", tags: ["runtime"] },
      ),
    ]);
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    try {
      const first = await service.refresh();
      expect(first.conceptCount).toBe(2);
      expect((await service.search("local runtime"))[0]).toMatchObject({
        path: "/concepts/ams.md",
        type: "model-runtime",
      });
      expect(await service.graph()).toMatchObject({
        edges: [{ source: "/concepts/andromeda.md", target: "/concepts/ams.md" }],
        brokenLinks: [],
      });

      const current = await service.read("/concepts/ams.md");
      expect(current).not.toBeNull();
      const committed = await service.update(
        [
          {
            type: "patch",
            path: "/concepts/ams.md",
            expectedContentHash: current!.contentHash,
            frontmatter: { tags: ["runtime", "quantization"] },
            replaceSection: { heading: "Qualification", content: "Native layer gate passed." },
          },
        ],
        {
          actor: "memory-plugin:test",
          evidence: { uri: "session://test/primary", contentHash: hash("primary evidence") },
        },
      );

      expect(committed.revision).toBe("commit-2");
      expect(authority.transactions).toHaveLength(1);
      expect(authority.transactions[0].baseRevision).toBe("commit-1");
      expect((await service.search("qualification", { tags: ["quantization"] }))[0]?.path).toBe(
        "/concepts/ams.md",
      );
      expect((await service.read("/concepts/ams.md"))?.body).toContain("Native layer gate passed.");
    } finally {
      projection.close();
    }
  });

  test("edge input: malformed and reserved concepts fail before replacing a good projection", () => {
    const projection = new UnderstoryMemoryProjection();
    try {
      const good = {
        revision: "good",
        documents: [concept("/concepts/good.md", "fact", "Good", "Known-good content.\n")],
      };
      const baseline = projection.rebuild(good);
      expect(() =>
        projection.rebuild({
          revision: "bad",
          documents: [{ path: "/concepts/index.md", raw: "---\ntype: fact\n---\nReserved.\n" }],
        }),
      ).toThrow("reserved filename");
      expect(projection.metadata()).toEqual(baseline);
      expect(projection.read("/concepts/good.md")?.frontmatter.title).toBe("Good");
      expect(() =>
        projection.rebuild({
          revision: "bad-yaml",
          documents: [{ path: "/concepts/bad.md", raw: "---\ntitle: missing-type\n---\nNo type.\n" }],
        }),
      ).toThrow('requires a normalized non-empty "type"');
      expect(projection.metadata()).toEqual(baseline);
      expect(() =>
        projection.rebuild({
          revision: "alias-yaml",
          documents: [
            {
              path: "/concepts/alias.md",
              raw: "---\ntype: fact\nshared: &shared [one, two]\ntags: *shared\n---\nAliases.\n",
            },
          ],
        }),
      ).toThrow("uses aliases, anchors, tags, or merge keys");
      expect(projection.metadata()).toEqual(baseline);
      const quotedIndicator = concept(
        "/concepts/quoted.md",
        "fact",
        "Quoted",
        "Quoted YAML indicators remain ordinary text.\n",
        { description: "The literal *wildcard and !tag strings are evidence." },
      );
      expect(parseMemoryConcept(quotedIndicator).frontmatter.description).toContain("*wildcard");
      expect(() => projection.search("term ".repeat(65))).toThrow("exceeds 64 terms");
      expect(() =>
        projection.search("term", { tags: Array.from({ length: 129 }, (_, index) => `tag-${index}`) }),
      ).toThrow("at most 128 entries");
      expect(() =>
        projection.rebuild({
          revision: "too-many",
          documents: Array.from({ length: 50_001 }, () => good.documents[0]),
        }),
      ).toThrow("exceeds 50000 concepts");
      expect(projection.metadata()).toEqual(baseline);
    } finally {
      projection.close();
    }
  });

  test("denied failure: stale state rejection never advances the derivative projection", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept("/concepts/fact.md", "fact", "Fact", "Original.\n"),
    ]);
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    try {
      const before = await service.refresh();
      const current = await service.read("/concepts/fact.md");
      authority.rejectNextTransaction = true;
      await expect(
        service.update(
          [
            {
              type: "put",
              path: "/concepts/fact.md",
              frontmatter: { type: "fact", title: "Fact" },
              body: "Uncommitted candidate.\n",
              expectedContentHash: current!.contentHash,
            },
          ],
          {
            actor: "memory-plugin:test",
            evidence: { uri: "session://test/stale", contentHash: hash("stale evidence") },
          },
        ),
      ).rejects.toThrow("optimistic base commit is stale");
      expect(projection.metadata()).toEqual(before);
      expect(projection.read("/concepts/fact.md")?.body).toBe("Original.\n");
    } finally {
      projection.close();
    }
  });

  test("successful update verifies and rebuilds its exact commit when another writer commits immediately", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept("/concepts/fact.md", "fact", "Fact", "Original.\n"),
    ]);
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    try {
      const current = await service.read("/concepts/fact.md");
      authority.publishLaterCommitAfterTransaction = true;
      const committed = await service.update(
        [
          {
            type: "put",
            path: "/concepts/fact.md",
            frontmatter: { type: "fact", title: "Fact" },
            body: "First writer's exact commit.\n",
            expectedContentHash: current!.contentHash,
          },
        ],
        {
          actor: "memory-plugin:test",
          evidence: { uri: "session://test/exact-commit", contentHash: hash("exact commit evidence") },
        },
      );
      expect(committed.revision).toBe("commit-2");
      expect(projection.metadata()?.revision).toBe("commit-2");
      expect(projection.read("/concepts/fact.md")?.body).toBe("First writer's exact commit.\n");
      expect(projection.read("/concepts/later.md")).toBeNull();
      expect(authority.snapshot.revision).toBe("commit-later");

      expect((await service.search("second writer"))[0]?.path).toBe("/concepts/later.md");
      expect(projection.metadata()?.revision).toBe("commit-later");
    } finally {
      projection.close();
    }
  });

  test("concurrent requests serialize snapshot refresh and projection access", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept("/concepts/alpha.md", "fact", "Alpha", "Alpha revision.\n"),
    ]);
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    authority.readSnapshotHook = async (call) => {
      if (call === 1) await firstReadGate;
    };
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    try {
      const first = service.search("alpha");
      await waitFor(() => authority.readCalls === 1);
      authority.snapshot = {
        revision: "commit-beta",
        documents: [concept("/concepts/beta.md", "fact", "Beta", "Beta revision.\n")],
      };
      const second = service.search("beta");
      await Bun.sleep(5);
      expect(authority.readCalls).toBe(1);
      expect(authority.maxConcurrentReads).toBe(1);

      releaseFirstRead();
      expect((await first)[0]?.path).toBe("/concepts/alpha.md");
      expect((await second)[0]?.path).toBe("/concepts/beta.md");
      expect(authority.maxConcurrentReads).toBe(1);
      expect(projection.metadata()?.revision).toBe("commit-beta");
    } finally {
      releaseFirstRead();
      projection.close();
    }
  });

  test("public transaction bounds fail before authority or projection mutation", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept("/concepts/fact.md", "fact", "Fact", "Original.\n"),
    ]);
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    try {
      const before = await service.refresh();
      const reads = authority.readCalls;
      expect(() =>
        service.update(
          [
            {
              type: "delete",
              path: "/concepts/fact.md",
              expectedContentHash: hash(authority.snapshot.documents[0].raw),
            },
          ],
          {
            actor: "a".repeat(513),
            evidence: { uri: "session://test/bounds", contentHash: hash("bounds") },
          },
        ),
      ).toThrow("actor exceeds 512 bytes");
      expect(() => service.search("q".repeat(16 * 1024 + 1))).toThrow("query exceeds 16384 bytes");
      expect(authority.readCalls).toBe(reads);
      expect(authority.transactions).toHaveLength(0);
      expect(projection.metadata()).toEqual(before);
    } finally {
      projection.close();
    }
  });

  test("denied runtime variants and prototype-bearing patches fail before authority access", async () => {
    const authority = new FakeCanonicalMemoryAuthority([
      concept("/concepts/fact.md", "fact", "Fact", "Original.\n"),
    ]);
    const projection = new UnderstoryMemoryProjection();
    const service = new UnderstoryMemoryService(authority, projection);
    const options = {
      actor: "memory-plugin:test",
      evidence: { uri: "session://test/runtime-validation", contentHash: hash("runtime validation") },
    };
    try {
      const baseline = await service.refresh();
      const reads = authority.readCalls;
      const currentHash = hash(authority.snapshot.documents[0].raw);
      expect(() => service.update([null] as never, options)).toThrow(
        "memory update at index 0 must be a plain object",
      );
      expect(() =>
        service.update(
          [{ type: "surprise", path: "/concepts/fact.md", expectedContentHash: currentHash }] as never,
          options,
        ),
      ).toThrow('has unsupported type "surprise"');
      const poisoned = JSON.parse(
        `{"type":"patch","path":"/concepts/fact.md","expectedContentHash":"${currentHash}","frontmatter":{"__proto__":{"polluted":true}}}`,
      ) as never;
      expect(() => service.update([poisoned], options)).toThrow(
        'frontmatter contains forbidden key "__proto__"',
      );
      const inherited = Object.create({ injected: true }) as Record<string, unknown>;
      inherited.type = "patch";
      inherited.path = "/concepts/fact.md";
      inherited.expectedContentHash = currentHash;
      expect(() => service.update([inherited] as never, options)).toThrow(
        "memory update at index 0 must be a plain object",
      );
      expect(authority.readCalls).toBe(reads);
      expect(authority.transactions).toHaveLength(0);
      expect(projection.metadata()).toEqual(baseline);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    } finally {
      projection.close();
    }
  });

  test("FTS row tampering is discarded by deterministic projection admission", () => {
    const snapshot = {
      revision: "fts-authority",
      documents: [concept("/concepts/fact.md", "fact", "Fact", "Canonical searchable term.\n")],
    };
    const projection = new UnderstoryMemoryProjection();
    try {
      const baseline = projection.rebuild(snapshot);
      const database = (
        projection as unknown as { database: { exec(statement: string): void } }
      ).database;
      database.exec("DELETE FROM concept_fts WHERE path = '/concepts/fact.md'");
      expect(projection.search("canonical searchable")).toEqual([]);
      expect(projection.ensure(snapshot)).toEqual(baseline);
      expect(projection.search("canonical searchable")[0]?.path).toBe("/concepts/fact.md");
    } finally {
      projection.close();
    }
  });

  test("graph and broken-link tampering is discarded by deterministic projection admission", () => {
    const snapshot = {
      revision: "graph-authority",
      documents: [
        concept("/concepts/a.md", "fact", "A", "Links to [B](/concepts/b.md).\n"),
        concept("/concepts/b.md", "fact", "B", "No outgoing links.\n"),
      ],
    };
    const projection = new UnderstoryMemoryProjection();
    try {
      const baseline = projection.rebuild(snapshot);
      const database = (
        projection as unknown as { database: { exec(statement: string): void } }
      ).database;
      database.exec(`
        DELETE FROM links;
        INSERT INTO broken_links(source, target) VALUES ('/concepts/a.md', '/concepts/poison.md');
      `);
      expect(projection.graph()).toMatchObject({
        edges: [],
        brokenLinks: [{ path: "/concepts/a.md", target: "/concepts/poison.md" }],
      });
      expect(projection.ensure(snapshot)).toEqual(baseline);
      expect(projection.graph()).toMatchObject({
        edges: [{ source: "/concepts/a.md", target: "/concepts/b.md" }],
        brokenLinks: [],
      });
    } finally {
      projection.close();
    }
  });

  test("projection schema and metadata corruption rebuild fail-closed from Markdown", () => {
    const snapshot = {
      revision: "schema-authority",
      documents: [concept("/concepts/fact.md", "fact", "Fact", "Canonical.\n")],
    };
    const projection = new UnderstoryMemoryProjection();
    try {
      const baseline = projection.rebuild(snapshot);
      const database = (
        projection as unknown as { database: { exec(statement: string): void } }
      ).database;
      database.exec("UPDATE projection_meta SET value = '999' WHERE key = 'schema_version'");
      expect(projection.metadata()).toBeNull();
      expect(projection.ensure(snapshot)).toEqual(baseline);
      database.exec("DROP TABLE links");
      expect(projection.ensure(snapshot)).toEqual(baseline);
      expect(projection.metadata()).toEqual(baseline);
      expect(projection.read("/concepts/fact.md")?.body).toBe("Canonical.\n");
    } finally {
      projection.close();
    }
  });
});

describe("deterministic memory migration receipts", () => {
  const overlapping: LegacyMemorySource[] = Array.from({ length: 5 }, (_, index) => [
    {
      sourcePath: `wiki/topic-${index + 1}.md`,
      topic: `Shared Topic ${index + 1}`,
      bytes: `# Shared Topic ${index + 1}\n\nWiki evidence ${index + 1}.\n`,
    },
    {
      sourcePath: `research/topic-${index + 1}.json`,
      topic: `Shared Topic ${index + 1}`,
      bytes: JSON.stringify({ source: "research", topic: index + 1 }),
    },
  ]).flat();

  test("primary path: five overlapping topics merge while retaining every source hash", () => {
    const plan = planMemoryMigration(overlapping);
    expect(plan.receipt).toMatchObject({
      schemaVersion: 1,
      sourceCount: 10,
      conceptCount: 5,
      mergedSourceCount: 5,
    });
    expect(plan.concepts).toHaveLength(5);
    expect(plan.concepts.every((entry) => entry.evidence.length === 2)).toBeTrue();
    expect(new Set(plan.concepts.flatMap((entry) => entry.evidence.map((evidence) => evidence.sha256))).size).toBe(10);
    for (const migrated of plan.concepts) {
      const parsed = parseMemoryConcept(migrated);
      expect((parsed.frontmatter.andromeda_evidence as unknown[]).length).toBe(2);
      expect(hash(migrated.raw)).toBe(migrated.contentHash);
      expect(migrated.raw).toContain("andromeda_evidence:\n  -\n");
    }
  });

  test("edge input: source order cannot change paths, counts, hashes, or generated bytes", () => {
    const forward = planMemoryMigration(overlapping);
    const reverse = planMemoryMigration([...overlapping].reverse());
    expect(reverse.receipt).toEqual(forward.receipt);
    expect(reverse.concepts).toEqual(forward.concepts);

    const reserved = planMemoryMigration([
      { sourcePath: "AGENTS.md", bytes: "# Instructions\n\nHistorical, non-authoritative evidence.\n" },
      { sourcePath: "index.md", bytes: "# Generated index\n\nHistorical index evidence.\n" },
    ]);
    expect(reserved.concepts.map((entry) => entry.path)).toEqual([
      "/concepts/generated-index.md",
      "/concepts/instructions.md",
    ]);
    expect(reserved.concepts.every((entry) => !/\/(?:agents|index)\.md$/.test(entry.path))).toBeTrue();

    const unicodeSources: LegacyMemorySource[] = [
      { sourcePath: "wiki/Ångström.md", topic: "Ångström", bytes: "# Ångström\n\nFirst.\n" },
      { sourcePath: "wiki/évidence.md", topic: "Évidence", bytes: "# Évidence\n\nSecond.\n" },
      { sourcePath: "wiki/😀.md", topic: "Emoji", bytes: "# Emoji\n\nThird.\n" },
    ];
    const unicodeForward = planMemoryMigration(unicodeSources);
    const unicodeReverse = planMemoryMigration([...unicodeSources].reverse());
    expect(unicodeReverse).toEqual(unicodeForward);
    expect(unicodeForward.receipt.sources.map((source) => source.sourcePath)).toEqual([
      "wiki/Ångström.md",
      "wiki/évidence.md",
      "wiki/😀.md",
    ]);
  });

  test("non-Markdown sources retain leading/trailing bytes behind a collision-safe dynamic fence", () => {
    const sourceText = "  leading spaces\n```\n~~~\ntrailing spaces  ";
    const plan = planMemoryMigration([
      { sourcePath: "artifacts/evidence.json", bytes: sourceText, topic: "Fenced Evidence" },
    ]);
    const body = parseMemoryConcept(plan.concepts[0]).body;
    expect(body).toContain(`\`\`\`\`json\n${sourceText}\n\`\`\`\``);
    expect(plan.concepts[0].evidence[0]).toMatchObject({
      sourceBytes: Buffer.byteLength(sourceText, "utf8"),
      sha256: hash(sourceText),
    });
  });

  test("denied failure: duplicate provenance paths are rejected and changed bytes change the plan hash", () => {
    expect(() =>
      planMemoryMigration([
        { sourcePath: "wiki/same.md", bytes: "one" },
        { sourcePath: "wiki/same.md", bytes: "two" },
      ]),
    ).toThrow("repeats source path");
    expect(() =>
      planMemoryMigration(
        Array.from({ length: 10_001 }, (_, index) => ({
          sourcePath: `bulk/${index}.md`,
          bytes: "bounded",
        })),
      ),
    ).toThrow("exceeds 10000 sources");
    expect(() =>
      planMemoryMigration([
        { sourcePath: "wiki/topic.md", topic: "x".repeat(1025), bytes: "bounded" },
      ]),
    ).toThrow("topic is invalid");
    expect(() =>
      planMemoryMigration([
        { sourcePath: `wiki/${"x".repeat(256)}.md`, bytes: "bounded" },
      ]),
    ).toThrow("unsafe segment");
    const original = planMemoryMigration(overlapping);
    const changed = planMemoryMigration([
      ...overlapping.slice(0, -1),
      { ...overlapping.at(-1)!, bytes: '{"source":"research","topic":5,"changed":true}' },
    ]);
    expect(changed.receipt.planHash).not.toBe(original.receipt.planHash);
    const changedSource = changed.receipt.sources.find((source) => source.sourcePath === "research/topic-5.json");
    const originalSource = original.receipt.sources.find((source) => source.sourcePath === "research/topic-5.json");
    expect(changedSource?.sha256).not.toBe(originalSource?.sha256);
  });
});
