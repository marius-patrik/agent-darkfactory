import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectMemoryIntegrity,
  listMemoryRecords,
  memoryStatus,
  rebuildMemoryProjections,
  rememberMemory,
  renderStartupMemory,
  retractMemory,
  supersedeMemory,
  type MemoryEvidence,
  type MemoryEvent,
} from "../../src/manager/memory";
import { ensureSharedState, sharedStateAt, type SharedState } from "../../src/manager/state";
import { readStateManifest, stateV2Paths } from "../../src/manager/state-v2";

const VERIFIED: MemoryEvidence = {
  uri: "user://instruction/agent-name",
  contentHash: "a".repeat(64),
  sourceClass: "verified",
  confidence: 1,
};

async function fixture(): Promise<{ root: string; state: SharedState }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-memory-"));
  const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
  await ensureSharedState(state);
  return { root, state };
}

async function machineEvents(state: SharedState): Promise<{ directory: string; names: string[]; events: MemoryEvent[] }> {
  const manifest = await readStateManifest(state);
  const directory = path.join(stateV2Paths(state).memoryEventsDir, manifest!.machineId);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const events = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as MemoryEvent),
  );
  return { directory, names, events };
}

describe("canonical event-authoritative memory", () => {
  test("requires evidence and rejects an implicit contradictory scalar", async () => {
    const { root, state } = await fixture();
    try {
      await expect(
        rememberMemory(state, {
          scope: "identity",
          subject: "agent",
          predicate: "name",
          value: "Rommie",
          evidence: undefined as unknown as MemoryEvidence,
        }),
      ).rejects.toThrow(/evidence is required/);

      const active = await rememberMemory(state, {
        scope: "identity",
        subject: "agent",
        predicate: "name",
        value: "Rommie",
        evidence: VERIFIED,
      });
      await expect(
        rememberMemory(state, {
          scope: "identity",
          subject: "agent",
          predicate: "name",
          value: "Not Rommie",
          evidence: { ...VERIFIED, uri: "runtime://provider/generated-memory", contentHash: "b".repeat(64) },
        }),
      ).rejects.toThrow(/explicitly supersede.*or.*disputed/);

      const disputed = await rememberMemory(state, {
        scope: "identity",
        subject: "agent",
        predicate: "name",
        value: "Not Rommie",
        evidence: { ...VERIFIED, uri: "runtime://provider/generated-memory", contentHash: "b".repeat(64) },
        status: "disputed",
      });
      expect(disputed.status).toBe("disputed");
      expect((await listMemoryRecords(state, { status: "active" })).map((record) => record.id)).toEqual([active.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stores intent-only schema-v2 events and replays explicit supersession", async () => {
    const { root, state } = await fixture();
    try {
      const first = await rememberMemory(
        state,
        {
          scope: "profile",
          subject: "user",
          predicate: "timezone",
          value: "UTC",
          evidence: { ...VERIFIED, uri: "user://instruction/timezone-old", contentHash: "c".repeat(64) },
        },
        { now: new Date("2026-07-09T10:00:00.000Z") },
      );
      const firstEventState = await machineEvents(state);
      const firstEventBytes = await readFile(path.join(firstEventState.directory, firstEventState.names[0]), "utf8");

      const second = await supersedeMemory(
        state,
        first.id,
        {
          value: "Europe/Bratislava",
          evidence: { ...VERIFIED, uri: "user://instruction/timezone-current", contentHash: "d".repeat(64) },
        },
        { now: new Date("2026-07-10T10:00:00.000Z") },
      );

      const records = await listMemoryRecords(state);
      const old = records.find((record) => record.id === first.id)!;
      expect(old.status).toBe("superseded");
      expect(old.evidence.uri).toBe("user://instruction/timezone-old");
      expect(old.supersededBy).toBe(second.id);
      expect(second.supersedes).toEqual([first.id]);
      expect(second.status).toBe("active");

      const eventState = await machineEvents(state);
      expect(eventState.events).toHaveLength(2);
      expect(eventState.events[0].schemaVersion).toBe(2);
      expect(eventState.events[0].type).toBe("memory.remembered");
      expect(eventState.events[1].type).toBe("memory.superseded");
      expect(eventState.events[1].previousEventHash).toBe(eventState.events[0].eventHash);
      expect("changes" in eventState.events[0]).toBe(false);
      expect(await readFile(path.join(eventState.directory, eventState.names[0]), "utf8")).toBe(firstEventBytes);

      const startup = await readFile(path.join(stateV2Paths(state).memoryViewsDir, "startup.md"), "utf8");
      expect(startup).toContain("Europe/Bratislava");
      expect(startup).toContain("source user://instruction/timezone-current");
      expect(startup).not.toContain('= "UTC"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders deterministically from the event-stream timestamp and reports one event per mutation", async () => {
    const { root, state } = await fixture();
    try {
      const remembered = await rememberMemory(
        state,
        {
          scope: "preference",
          subject: "user",
          predicate: "output-style",
          value: "concise",
          evidence: { ...VERIFIED, uri: "user://instruction/style", contentHash: "e".repeat(64) },
          observedAt: "2026-07-10T08:00:00.000Z",
        },
        { now: new Date("2026-07-10T09:00:00.000Z") },
      );
      const repeated = await rememberMemory(
        state,
        {
          scope: "preference",
          subject: "user",
          predicate: "output-style",
          value: "concise",
          evidence: { ...VERIFIED, uri: "user://instruction/style", contentHash: "e".repeat(64) },
        },
        { now: new Date("2026-07-10T09:30:00.000Z") },
      );
      expect(repeated.id).toBe(remembered.id);
      const first = await renderStartupMemory(state);
      const second = await renderStartupMemory(state);
      expect(second.content).toBe(first.content);
      expect(second.projectionHash).toBe(first.projectionHash);
      expect(second.changed).toBe(false);
      expect(second.content).toContain("Projection through: 2026-07-10T09:00:00.000Z");
      expect(second.content).toContain("age 1h");

      const status = await memoryStatus(state);
      expect(status.records).toBe(1);
      expect(status.events).toBe(1);
      expect(status.byStatus.active).toBe(1);
      expect(status.projectionHash).toBe(first.projectionHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats record and startup files as replaceable projections and repairs them byte-for-byte", async () => {
    const { root, state } = await fixture();
    try {
      const record = await rememberMemory(
        state,
        {
          scope: "profile",
          subject: "user",
          predicate: "display-name",
          value: "Patrik",
          evidence: { ...VERIFIED, uri: "user://instruction/display-name", contentHash: "f".repeat(64) },
        },
        { now: new Date("2026-07-10T10:00:00.000Z") },
      );
      const paths = stateV2Paths(state);
      const recordPath = path.join(paths.memoryRecordsDir, `${record.id}.json`);
      const startupPath = path.join(paths.memoryViewsDir, "startup.md");
      const expectedRecord = await readFile(recordPath, "utf8");
      const expectedStartup = await readFile(startupPath, "utf8");
      const events = await machineEvents(state);
      const eventBytes = await Promise.all(events.names.map((name) => readFile(path.join(events.directory, name), "utf8")));
      const initial = await inspectMemoryIntegrity(state);
      expect(initial.ok).toBe(true);

      await writeFile(recordPath, '{"schemaVersion":2,"value":"forged"}\n', "utf8");
      await rm(startupPath, { force: true });
      await writeFile(path.join(paths.memoryRecordsDir, "fabricated.json"), '{"fake":true}\n', "utf8");
      const abandoned = path.join(
        paths.memoryViewsDir,
        ".startup.md.2147483647.00000000-0000-4000-8000-000000000000.tmp",
      );
      await writeFile(abandoned, "abandoned\n", "utf8");
      const abandonedBackup = path.join(
        paths.memoryViewsDir,
        ".startup.md.2147483647.00000000-0000-4000-8000-000000000001.bak",
      );
      await writeFile(abandonedBackup, expectedStartup, "utf8");
      const activeBackup = path.join(
        paths.memoryViewsDir,
        `.startup.md.${process.pid}.00000000-0000-4000-8000-000000000000.bak`,
      );
      await writeFile(activeBackup, expectedStartup, "utf8");
      const damaged = await inspectMemoryIntegrity(state);
      expect(damaged.eventIntegrity).toBe(true);
      expect(damaged.projectionIntegrity).toBe(false);
      expect(damaged.issues.join("\n")).toMatch(/content mismatch|unexpected memory projection/);

      const rebuilt = await rebuildMemoryProjections(state);
      expect(rebuilt.projectionHash).toBe(initial.projectionHash!);
      expect(await readFile(recordPath, "utf8")).toBe(expectedRecord);
      expect(await readFile(startupPath, "utf8")).toBe(expectedStartup);
      expect(await Bun.file(path.join(paths.memoryRecordsDir, "fabricated.json")).exists()).toBe(false);
      expect(await Bun.file(abandoned).exists()).toBe(false);
      expect(await Bun.file(abandonedBackup).exists()).toBe(false);
      expect(await Bun.file(activeBackup).exists()).toBe(true);
      await rm(activeBackup, { force: true });
      expect(
        await Promise.all(events.names.map((name) => readFile(path.join(events.directory, name), "utf8"))),
      ).toEqual(eventBytes);
      expect((await inspectMemoryIntegrity(state)).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores a fabricated projection-only record and removes it during canonical replay", async () => {
    const { root, state } = await fixture();
    try {
      const fakePath = path.join(stateV2Paths(state).memoryRecordsDir, "projection_only.json");
      await writeFile(
        fakePath,
        `${JSON.stringify({ schemaVersion: 2, id: "projection_only", value: "must-not-be-authority" })}\n`,
        "utf8",
      );
      expect((await inspectMemoryIntegrity(state)).projectionIntegrity).toBe(false);
      expect(await listMemoryRecords(state)).toEqual([]);
      expect(await Bun.file(fakePath).exists()).toBe(false);
      expect((await inspectMemoryIntegrity(state)).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on event tampering", async () => {
    const { root, state } = await fixture();
    try {
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "locale",
        value: "sk-SK",
        evidence: VERIFIED,
      });
      const { directory, names } = await machineEvents(state);
      const eventPath = path.join(directory, names[0]);
      const event = JSON.parse(await readFile(eventPath, "utf8")) as MemoryEvent;
      if (event.type !== "memory.remembered") throw new Error("unexpected test event type");
      event.data.record.value = "forged";
      await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");

      const inspection = await inspectMemoryIntegrity(state);
      expect(inspection.ok).toBe(false);
      expect(inspection.eventIntegrity).toBe(false);
      expect(inspection.issues.join("\n")).toContain("hash mismatch");
      await expect(listMemoryRecords(state)).rejects.toThrow(/hash mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects copied events whose immutable path identity collides with their envelope", async () => {
    const { root, state } = await fixture();
    try {
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "locale",
        value: "sk-SK",
        evidence: VERIFIED,
      });
      const { directory, names, events } = await machineEvents(state);
      const copiedPath = path.join(directory, `0000000000000002-${events[0].id}.json`);
      await copyFile(path.join(directory, names[0]), copiedPath);
      const inspection = await inspectMemoryIntegrity(state);
      expect(inspection.eventIntegrity).toBe(false);
      expect(inspection.issues.join("\n")).toContain("path identity mismatch");
      await expect(listMemoryRecords(state)).rejects.toThrow(/path identity mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent appends into one contiguous private hash chain", async () => {
    const { root, state } = await fixture();
    try {
      const count = 24;
      const now = new Date("2026-07-10T12:00:00.000Z");
      const records = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          rememberMemory(
            state,
            {
              scope: "concurrency",
              subject: "test",
              predicate: `key-${index}`,
              value: index,
              evidence: { ...VERIFIED, uri: `test://concurrency/${index}` },
            },
            { now },
          ),
        ),
      );
      expect(new Set(records.map((record) => record.id)).size).toBe(count);
      const eventState = await machineEvents(state);
      expect(eventState.events).toHaveLength(count);
      for (const [index, event] of eventState.events.entries()) {
        expect(event.machineSequence).toBe(index + 1);
        expect(event.previousEventHash).toBe(index === 0 ? null : eventState.events[index - 1].eventHash);
      }
      expect(await listMemoryRecords(state)).toHaveLength(count);
      expect((await inspectMemoryIntegrity(state)).ok).toBe(true);

      if (process.platform !== "win32") {
        const paths = stateV2Paths(state);
        expect((await stat(paths.memoryEventsDir)).mode & 0o777).toBe(0o700);
        expect((await stat(eventState.directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(eventState.directory, eventState.names[0]))).mode & 0o777).toBe(0o600);
        expect((await stat(path.join(paths.memoryRecordsDir, `${records[0].id}.json`))).mode & 0o777).toBe(0o600);
        expect((await stat(path.join(paths.memoryViewsDir, "startup.md"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never injects secret or inactive records into startup context", async () => {
    const { root, state } = await fixture();
    try {
      const obsolete = await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "obsolete-label",
        value: "DO-NOT-INJECT-INACTIVE",
        evidence: { ...VERIFIED, uri: "user://instruction/obsolete", contentHash: "2".repeat(64) },
      });
      await retractMemory(
        state,
        obsolete.id,
        { ...VERIFIED, uri: "user://instruction/retract-obsolete", contentHash: "3".repeat(64) },
        "explicitly retired",
      );
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "display-name",
        value: "Patrik",
        evidence: { ...VERIFIED, uri: "user://instruction/display-name", contentHash: "f".repeat(64) },
      });
      await rememberMemory(state, {
        scope: "credentials",
        subject: "provider",
        predicate: "token",
        value: "secret://provider-token",
        evidence: { ...VERIFIED, uri: "secret://registry/provider-token", contentHash: "1".repeat(64) },
        sensitivity: "secret",
      });
      const rendered = await renderStartupMemory(state);
      expect(rendered.content).toContain("Patrik");
      expect(rendered.content).not.toContain("secret://provider-token");
      expect(rendered.content).not.toContain("secret://registry/provider-token");
      expect(rendered.content).not.toContain("DO-NOT-INJECT-INACTIVE");
      expect(rendered.included).toBe(1);
      const status = await memoryStatus(state);
      expect(status.secretRecords).toBe(1);
      expect(status.byStatus.retracted).toBe(1);

      await expect(
        rememberMemory(state, {
          scope: "credentials",
          subject: "provider",
          predicate: "plaintext-token",
          value: "DO-NOT-STORE-SECRET",
          evidence: { ...VERIFIED, uri: "secret://registry/plaintext-token", contentHash: "4".repeat(64) },
          sensitivity: "secret",
        }),
      ).rejects.toThrow(/plaintext secrets are forbidden/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not treat provider-native history as canonical memory", async () => {
    const { root, state } = await fixture();
    try {
      const providerHistory = path.join(state.userHome, ".codex", "sessions", "provider-history.jsonl");
      await mkdir(path.dirname(providerHistory), { recursive: true });
      await writeFile(providerHistory, '{"message":"provider-generated claim"}\n', "utf8");
      expect(await listMemoryRecords(state)).toEqual([]);
      const rendered = await renderStartupMemory(state);
      expect(rendered.content).toContain("No active non-secret memory records");
      expect(rendered.content).not.toContain("provider-generated claim");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
