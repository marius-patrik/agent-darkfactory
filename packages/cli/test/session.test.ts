import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../src/state";
import {
  appendSessionMessage,
  assertSessionAppendWithinBounds,
  beginSessionTurn,
  createSession,
  inspectSessionIntegrity,
  listSessionIds,
  listSessions,
  loadSessionEvents,
  loadSessionState,
  loadTranscript,
  runSessionTurn,
  sessionPaths,
  streamSessionTurn,
  switchSessionProvider,
  withSessionWriteLock,
  withSessionWriteTransaction,
  type ProviderAdapter,
  type SessionDescriptor,
  type SessionTranscript,
  type TurnRequest,
  type TurnResult,
} from "../../sdk/harness/session";
import { FakeProviderAdapter } from "../../sdk/harness/session-adapters";
import { providerSessionAdapter } from "../src/session-adapters";
import { renewableLockDatabasePath } from "../src/state-lock";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("ANDROMEDA_")) delete copy[key];
  }
  return copy;
}

async function runAgents(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: {
      ...cleanEnv(),
      ANDROMEDA_HOME: path.join(cwd, ".andromeda"),
      ANDROMEDA_ROOT: cwd,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

function canonicalTestValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) output[key] = canonicalTestValue(member);
  }
  return output;
}

function refreshTestEventHash(event: Record<string, unknown>): void {
  const { eventHash: _eventHash, ...unsigned } = event;
  event.eventHash = createHash("sha256").update(JSON.stringify(canonicalTestValue(unsigned))).digest("hex");
}

async function singleSessionEventBytes(state: ReturnType<typeof sharedState>, sessionId: string): Promise<number> {
  const eventsDir = sessionPaths(state, sessionId).eventsDir;
  const [machineId] = await readdir(eventsDir);
  const [eventFile] = await readdir(path.join(eventsDir, machineId));
  return (await stat(path.join(eventsDir, machineId, eventFile))).size;
}

async function addDirectoryScanPadding(directory: string): Promise<void> {
  for (let start = 0; start < 2_000; start += 200) {
    await Promise.all(
      Array.from({ length: 200 }, (_, offset) =>
        Bun.write(
          path.join(
            directory,
            `0000000000000002-admission-padding-${String(start + offset).padStart(4, "0")}.json`,
          ),
          "",
        ),
      ),
    );
  }
}

async function addSessionDirectoryScanPadding(directory: string): Promise<void> {
  for (let start = 0; start < 2_000; start += 200) {
    await Promise.all(
      Array.from({ length: 200 }, (_, offset) =>
        mkdir(path.join(directory, `admission-padding-${String(start + offset).padStart(4, "0")}`)),
      ),
    );
  }
}

async function waitForDirectoryWatch(directory: string): Promise<void> {
  const expectedInode = lstatSync(directory, { bigint: true }).ino.toString(16);
  const descriptorRoot = `/proc/${process.pid}/fdinfo`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const descriptor of readdirSync(descriptorRoot)) {
      try {
        const descriptorInfo = readFileSync(path.join(descriptorRoot, descriptor), "utf8");
        if (new RegExp(`^inotify .*\\bino:${expectedInode}\\b`, "m").test(descriptorInfo)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for a directory admission watch: ${directory}`);
}

async function waitForDirectoryWatchRelease(directory: string): Promise<void> {
  const expectedInode = lstatSync(directory, { bigint: true }).ino.toString(16);
  const descriptorRoot = `/proc/${process.pid}/fdinfo`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let admitted = false;
    for (const descriptor of readdirSync(descriptorRoot)) {
      try {
        const descriptorInfo = readFileSync(path.join(descriptorRoot, descriptor), "utf8");
        if (new RegExp(`^inotify .*\\bino:${expectedInode}\\b`, "m").test(descriptorInfo)) {
          admitted = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!admitted) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for a directory admission release: ${directory}`);
}

describe("session runtime", () => {
  test("creates session state and transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test", mode: "chat" });
      expect(descriptor.provider).toBe("fake");
      expect(descriptor.model).toBe("test");
      expect(descriptor.workdir).toBe(root);

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript).not.toBeNull();
      expect(transcript?.provider).toBe("fake");
      expect(transcript?.model).toBe("test");
      expect(transcript?.messages).toEqual([]);

      const sessionState = await loadSessionState(state, descriptor.sessionId);
      expect(sessionState).not.toBeNull();
      expect(sessionState?.turnCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runSessionTurn appends messages and updates state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test" });
      const adapter = new FakeProviderAdapter();
      const result = await runSessionTurn(state, adapter, descriptor, { prompt: "hello" });
      expect(result.content).toBe("fake: hello");
      expect(result.role).toBe("assistant");
      expect(result.usage).toEqual({ tokensIn: 16, tokensOut: 11 });

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.messages.length).toBe(2);
      expect(transcript?.messages[0]).toEqual({ role: "user", content: "hello" });
      expect(transcript?.messages[1].role).toBe("assistant");
      expect(transcript?.messages[1].content).toBe("fake: hello");

      const sessionState = await loadSessionState(state, descriptor.sessionId);
      expect(sessionState?.turnCount).toBe(1);
      expect(sessionState?.lastTurnAt).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("system prompt is added once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test" });
      const adapter = new FakeProviderAdapter();
      await runSessionTurn(state, adapter, descriptor, { prompt: "a", systemPrompt: "be helpful" });
      await runSessionTurn(state, adapter, descriptor, { prompt: "b", systemPrompt: "be helpful" });
      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.messages.filter((m) => m.role === "system").length).toBe(1);
      expect(transcript?.messages[0]).toEqual({ role: "system", content: "be helpful" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("streamSessionTurn yields text chunks and persists transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test" });
      const adapter = new FakeProviderAdapter();
      const chunks: string[] = [];
      for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "hi there" })) {
        if (chunk.type === "text" && chunk.delta) chunks.push(chunk.delta);
      }
      expect(chunks.join("").trim()).toBe("fake: hi there");

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.messages.length).toBe(2);
      expect(transcript?.messages[1].content).toBe("fake: hi there");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("switching provider preserves transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "a" });
      const adapter = new FakeProviderAdapter();
      await runSessionTurn(state, adapter, descriptor, { prompt: "hello" });

      const switched = await switchSessionProvider(state, descriptor.sessionId, "fake", "b");
      expect(switched.provider).toBe("fake");
      expect(switched.model).toBe("b");

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.provider).toBe("fake");
      expect(transcript?.model).toBe("b");
      expect(transcript?.messages.length).toBe(2);

      const next = await runSessionTurn(state, adapter, switched, { prompt: "world" });
      expect(next.content).toBe("fake: world");
      const updated = await loadTranscript(state, descriptor.sessionId);
      expect(updated?.messages.length).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listSessions returns created sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const first = await createSession(state, { provider: "fake", model: "m1", sessionId: "session-1" });
      const second = await createSession(state, { provider: "fake", model: "m2", sessionId: "session-2" });
      const sessions = await listSessions(state);
      expect(sessions.map((s) => s.sessionId)).toEqual(["session-1", "session-2"]);
      expect(sessions.find((s) => s.sessionId === first.sessionId)?.model).toBe("m1");
      expect(sessions.find((s) => s.sessionId === second.sessionId)?.model).toBe("m2");
      expect(await listSessionIds(state, { maximumSessions: 2 })).toEqual(["session-1", "session-2"]);
      await expect(listSessionIds(state, { maximumSessions: 1 })).rejects.toThrow(/exceeds maximumSessions 1/);
      await expect(listSessionIds(state, { maximumSessions: 100_001 })).rejects.toThrow(
        /maximumSessions cannot exceed canonical ceiling 100000/,
      );
      await expect(listSessions(state, { maximumScannedEntries: 200_001 })).rejects.toThrow(
        /maximumScannedEntries cannot exceed canonical ceiling 200000/,
      );
      await expect(listSessions(state, { maximumEvents: 100_001 })).rejects.toThrow(
        /maximumEvents cannot exceed canonical ceiling 100000/,
      );
      await expect(inspectSessionIntegrity(state, { maximumSessions: 100_001 })).rejects.toThrow(
        /maximumSessions cannot exceed canonical ceiling 100000/,
      );
      await expect(inspectSessionIntegrity(state, { maximumScannedEntries: 200_001 })).rejects.toThrow(
        /maximumScannedEntries cannot exceed canonical ceiling 200000/,
      );
      await expect(inspectSessionIntegrity(state, { maximumEventScannedEntries: 200_001 })).rejects.toThrow(
        /maximumEventScannedEntries cannot exceed canonical ceiling 200000/,
      );
      await mkdir(path.join(state.sessionsDir, ".ignored"));
      await expect(listSessionIds(state, { maximumScannedEntries: 2 })).rejects.toThrow(
        /exceeds maximumScannedEntries 2/,
      );
      const boundedInspection = await inspectSessionIntegrity(state, { maximumScannedEntries: 2 });
      expect(boundedInspection.ok).toBe(false);
      expect(boundedInspection.issues.join("\n")).toContain("exceeds maximumScannedEntries 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("collection event budgets admit the exact aggregate boundary across sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-aggregate-exact-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const first = await createSession(state, { provider: "fake", model: "m1", sessionId: "aggregate-a" });
      const second = await createSession(state, { provider: "fake", model: "m2", sessionId: "aggregate-b" });
      const totalBytes =
        (await singleSessionEventBytes(state, first.sessionId)) +
        (await singleSessionEventBytes(state, second.sessionId));
      const exactLimits = {
        maximumEvents: 2,
        maximumBytes: totalBytes,
        maximumEventScannedEntries: 4,
      };

      expect((await listSessions(state, exactLimits)).map((session) => session.sessionId)).toEqual([
        first.sessionId,
        second.sessionId,
      ]);
      const inspection = await inspectSessionIntegrity(state, exactLimits);
      expect(inspection.ok).toBe(true);
      expect(inspection.events).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("collection event and byte budgets reject aggregate excess across sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-aggregate-content-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const first = await createSession(state, { provider: "fake", model: "m1", sessionId: "aggregate-a" });
      const second = await createSession(state, { provider: "fake", model: "m2", sessionId: "aggregate-b" });
      const totalBytes =
        (await singleSessionEventBytes(state, first.sessionId)) +
        (await singleSessionEventBytes(state, second.sessionId));

      await expect(listSessions(state, { maximumEvents: 1 })).rejects.toThrow(
        /session collection exceeds maximumEvents 1/,
      );
      const countInspection = await inspectSessionIntegrity(state, { maximumEvents: 1 });
      expect(countInspection.ok).toBe(false);
      expect(countInspection.issues.join("\n")).toContain("session collection exceeds maximumEvents 1");

      await expect(listSessions(state, { maximumEvents: 2, maximumBytes: totalBytes - 1 })).rejects.toThrow(
        /session collection exceeds maximumBytes/,
      );
      const byteInspection = await inspectSessionIntegrity(state, {
        maximumEvents: 2,
        maximumBytes: totalBytes - 1,
      });
      expect(byteInspection.ok).toBe(false);
      expect(byteInspection.issues.join("\n")).toContain("session collection exceeds maximumBytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("collection scan exhaustion stops integrity inspection after one bounded failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-aggregate-scan-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await createSession(state, { provider: "fake", model: "m1", sessionId: "aggregate-a" });
      await createSession(state, { provider: "fake", model: "m2", sessionId: "aggregate-b" });

      await expect(listSessions(state, { maximumEventScannedEntries: 3 })).rejects.toThrow(
        /session collection exceeds maximumEventScannedEntries 3/,
      );
      const inspection = await inspectSessionIntegrity(state, { maximumEventScannedEntries: 3 });
      expect(inspection.ok).toBe(false);
      expect(
        inspection.issues.filter((issue) => issue.includes("session collection exceeds maximumEventScannedEntries 3")),
      ).toHaveLength(1);
      expect(inspection.events).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds event count and bytes before loading canonical session content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-budget-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await expect(listSessions(state, { maximumEvents: 100_001 })).rejects.toThrow(
        /maximumEvents cannot exceed canonical ceiling 100000/,
      );
      await expect(inspectSessionIntegrity(state, { maximumEventScannedEntries: 200_001 })).rejects.toThrow(
        /maximumEventScannedEntries cannot exceed canonical ceiling 200000/,
      );
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "budget-session",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectories = await readdir(paths.eventsDir);
      expect(machineDirectories).toHaveLength(1);
      const eventFiles = await readdir(path.join(paths.eventsDir, machineDirectories[0]));
      expect(eventFiles).toHaveLength(1);
      const eventInfo = await stat(path.join(paths.eventsDir, machineDirectories[0], eventFiles[0]));

      expect(
        await loadSessionEvents(state, descriptor.sessionId, {
          maximumEvents: 1,
          maximumBytes: eventInfo.size,
          maximumScannedEntries: 2,
        }),
      ).toHaveLength(1);
      expect((await loadSessionState(state, descriptor.sessionId, { maximumEvents: 1 }))?.sessionId).toBe(
        descriptor.sessionId,
      );
      expect((await loadTranscript(state, descriptor.sessionId, { maximumBytes: eventInfo.size }))?.sessionId).toBe(
        descriptor.sessionId,
      );
      expect(
        (
          await listSessions(state, {
            maximumEvents: 1,
            maximumBytes: eventInfo.size,
            maximumEventScannedEntries: 2,
          })
        ).map((session) => session.sessionId),
      ).toEqual([descriptor.sessionId]);
      expect(
        (
          await inspectSessionIntegrity(state, {
            maximumEvents: 1,
            maximumBytes: eventInfo.size,
            maximumEventScannedEntries: 2,
          })
        ).ok,
      ).toBe(true);
      await expect(loadSessionEvents(state, "missing", { maximumEvents: 100_001 })).rejects.toThrow(
        /maximumEvents cannot exceed canonical ceiling 100000/,
      );
      await expect(loadSessionState(state, "missing", { maximumBytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow(
        /maximumBytes cannot exceed canonical ceiling 67108864/,
      );
      await expect(loadTranscript(state, "missing", { maximumScannedEntries: 200_001 })).rejects.toThrow(
        /maximumScannedEntries cannot exceed canonical ceiling 200000/,
      );
      await mkdir(path.join(paths.eventsDir, ".ignored"));
      await expect(
        loadSessionEvents(state, descriptor.sessionId, { maximumScannedEntries: 2 }),
      ).rejects.toThrow(/exceeds maximumScannedEntries 2/);
      await expect(
        loadSessionEvents(state, descriptor.sessionId, { maximumEvents: 1, maximumBytes: eventInfo.size - 1 }),
      ).rejects.toThrow(/exceeds maximumBytes/);

      await runSessionTurn(state, new FakeProviderAdapter(), descriptor, { prompt: "count bound" });
      await expect(loadSessionEvents(state, descriptor.sessionId, { maximumEvents: 4 })).rejects.toThrow(
        /exceeds maximumEvents 4/,
      );
      await expect(loadSessionState(state, descriptor.sessionId, { maximumEvents: 1 })).rejects.toThrow(
        /exceeds maximumEvents 1/,
      );
      await expect(loadTranscript(state, descriptor.sessionId, { maximumBytes: eventInfo.size })).rejects.toThrow(
        /exceeds maximumBytes/,
      );
      await expect(listSessions(state, { maximumEventScannedEntries: 2 })).rejects.toThrow(
        /exceeds maximumEventScannedEntries 2/,
      );
      await expect(listSessions(state, { maximumEvents: 1 })).rejects.toThrow(/exceeds maximumEvents 1/);
      const strictInspection = await inspectSessionIntegrity(state, { maximumEvents: 1 });
      expect(strictInspection.ok).toBe(false);
      expect(strictInspection.eventIntegrity).toBe(false);
      expect(strictInspection.issues.join("\n")).toContain("exceeds maximumEvents 1");
      await expect(loadSessionEvents(state, descriptor.sessionId, { maximumEvents: 100_001 })).rejects.toThrow(
        /maximumEvents cannot exceed canonical ceiling 100000/,
      );
      await expect(loadSessionEvents(state, descriptor.sessionId, { maximumBytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow(
        /maximumBytes cannot exceed canonical ceiling 67108864/,
      );
      await expect(
        loadSessionEvents(state, descriptor.sessionId, { maximumScannedEntries: 200_001 }),
      ).rejects.toThrow(/maximumScannedEntries cannot exceed canonical ceiling 200000/);
      expect(() => assertSessionAppendWithinBounds(99_999, 64 * 1024 * 1024 - 1, 1)).not.toThrow();
      expect(() => assertSessionAppendWithinBounds(100_000, 0, 1)).toThrow(/append exceeds maximumEvents/);
      expect(() => assertSessionAppendWithinBounds(0, 64 * 1024 * 1024, 1)).toThrow(
        /append exceeds maximumBytes/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects events-root replacement with a symlink after directory admission", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-events-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "events-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      await addDirectoryScanPadding(machineDirectory);
      const outsideEvents = path.join(root, "outside-events");
      const admittedEvents = path.join(root, "admitted-events");
      await mkdir(outsideEvents);

      const outcome = loadSessionEvents(state, descriptor.sessionId).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDirectoryWatch(paths.eventsDir);
      await rename(paths.eventsDir, admittedEvents);
      await symlink(outsideEvents, paths.eventsDir, "dir");

      expect(String(await outcome)).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects session-root replacement with a symlink after directory admission", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-root-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "root-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      await addDirectoryScanPadding(machineDirectory);
      const outsideSession = path.join(root, "outside-session");
      const admittedSession = path.join(root, "admitted-session");
      await mkdir(outsideSession);

      const outcome = loadSessionEvents(state, descriptor.sessionId).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDirectoryWatch(paths.dir);
      await rename(paths.dir, admittedSession);
      await symlink(outsideSession, paths.dir, "dir");

      expect(String(await outcome)).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects machine-partition replacement with a symlink after directory admission", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-machine-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "machine-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      await addDirectoryScanPadding(machineDirectory);
      const outsideMachine = path.join(root, "outside-machine");
      const admittedMachine = path.join(root, "admitted-machine");
      await mkdir(outsideMachine);

      const outcome = loadSessionEvents(state, descriptor.sessionId).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDirectoryWatch(machineDirectory);
      await rename(machineDirectory, admittedMachine);
      await symlink(outsideMachine, machineDirectory, "dir");

      expect(String(await outcome)).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an in-place event rewrite while a Windows write handle remains open", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-event-rewrite-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "event-rewrite-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      const eventFile = path.join(machineDirectory, (await readdir(machineDirectory)).sort()[0]);
      const paddingMachine = path.join(paths.eventsDir, "zzzz-admission-padding");
      await mkdir(paddingMachine);
      for (let start = 0; start < 4_000; start += 200) {
        await Promise.all(
          Array.from({ length: 200 }, (_, offset) =>
            Bun.write(
              path.join(
                paddingMachine,
                `.padding-${String(start + offset).padStart(4, "0")}`,
              ),
              "",
            ),
          ),
        );
      }

      const rewritten = JSON.parse(await readFile(eventFile, "utf8")) as Record<string, unknown> & {
        data: { metadata: Record<string, unknown> };
      };
      rewritten.data.metadata.admissionNonce = "00000000";
      refreshTestEventHash(rewritten);
      const admittedContent = `${JSON.stringify(rewritten, null, 2)}\n`;
      await Bun.write(eventFile, admittedContent);
      const admittedTimestamp = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      await utimes(eventFile, admittedTimestamp, admittedTimestamp);
      const originalInfo = await lstat(eventFile, { bigint: true });

      const handle = await open(eventFile, "r+");
      let rejection: unknown;
      let rewrittenInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        const outcome = loadSessionEvents(state, descriptor.sessionId).then(
          () => null,
          (error: unknown) => error,
        );
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });

        // Windows runners vary widely in how long directory admission takes.
        // Keep publishing unique, same-size, valid event bodies through one
        // retained handle until the reader finishes, restoring the admitted
        // timestamp after every write. Any first-read baseline must therefore
        // differ from the content observed by a later admitted read.
        let nonce = 1;
        const deadline = Date.now() + 25_000;
        while (!settled && Date.now() < deadline) {
          rewritten.data.metadata.admissionNonce = nonce.toString(16).padStart(8, "0");
          refreshTestEventHash(rewritten);
          const rewrittenBytes = Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`);
          if (rewrittenBytes.length !== Number(originalInfo.size)) {
            throw new Error("event rewrite test must preserve the admitted byte length");
          }
          await handle.write(rewrittenBytes, 0, rewrittenBytes.length, 0);
          await utimes(eventFile, admittedTimestamp, admittedTimestamp);
          nonce += 1;
          await Bun.sleep(1);
        }

        rejection = await outcome;
        rewrittenInfo = await lstat(eventFile, { bigint: true });
      } finally {
        await handle.close();
      }

      expect(rewrittenInfo?.dev).toBe(originalInfo.dev);
      expect(rewrittenInfo?.ino).toBe(originalInfo.ino);
      expect(rewrittenInfo?.size).toBe(originalInfo.size);
      expect(rewrittenInfo?.mtimeNs).toBe(originalInfo.mtimeNs);
      // The admitted verifier can observe either the transient write timestamp
      // or the later content hash. Both paths must fail closed, while the final
      // identity assertions above prove that no file replacement was involved.
      expect(String(rejection)).toMatch(/canonical session event (?:content )?changed during admission/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects event timestamp drift across admitted reads", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-event-mtime-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "event-mtime-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      const eventFile = path.join(machineDirectory, (await readdir(machineDirectory)).sort()[0]);
      for (let start = 0; start < 4_000; start += 200) {
        await Promise.all(
          Array.from({ length: 200 }, (_, offset) =>
            Bun.write(
              path.join(
                machineDirectory,
                `.padding-${String(start + offset).padStart(4, "0")}`,
              ),
              "",
            ),
          ),
        );
      }

      const admittedTimestamp = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      await utimes(eventFile, admittedTimestamp, admittedTimestamp);
      const outcome = loadSessionEvents(state, descriptor.sessionId).then(
        () => null,
        (error: unknown) => error,
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await waitForDirectoryWatch(machineDirectory);
      const deadline = Date.now() + 5_000;
      let timestampOffset = 2_000;
      while (!settled && Date.now() < deadline) {
        const changedTimestamp = new Date(admittedTimestamp.getTime() + timestampOffset);
        await utimes(eventFile, changedTimestamp, changedTimestamp);
        timestampOffset += 1_000;
        await Bun.sleep(1);
      }

      expect(String(await outcome)).toMatch(/canonical session event changed during admission/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps session admission through projection inspection", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-projection-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "projection-race",
      });
      const turnId = await beginSessionTurn(state, descriptor.sessionId);
      await appendSessionMessage(state, descriptor.sessionId, turnId, {
        role: "assistant",
        // Keep the retained session admission observably alive after the event
        // directory closes while the bounded transcript projection is read.
        content: "x".repeat(16 * 1024 * 1024),
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      for (let start = 0; start < 4_000; start += 200) {
        await Promise.all(
          Array.from({ length: 200 }, (_, offset) =>
            Bun.write(path.join(machineDirectory, `.projection-padding-${String(start + offset).padStart(4, "0")}`), ""),
          ),
        );
      }
      const replacementState = path.join(root, "replacement-state.json");
      await Bun.write(replacementState, await readFile(paths.stateFile));

      const outcome = inspectSessionIntegrity(state);
      await Promise.all([waitForDirectoryWatch(paths.eventsDir), waitForDirectoryWatch(paths.dir)]);
      await waitForDirectoryWatchRelease(paths.eventsDir);
      await waitForDirectoryWatch(paths.dir);
      await rename(replacementState, paths.stateFile);

      const inspection = await outcome;
      expect(inspection.ok).toBe(false);
      expect(inspection.eventIntegrity).toBe(false);
      expect(inspection.projectionIntegrity).toBe(false);
      expect(inspection.issues.join("\n")).toMatch(/canonical session directory changed during admission/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects global sessions-root replacement during bounded enumeration", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-global-scan-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await createSession(state, { provider: "fake", model: "test", sessionId: "scan-race" });
      await addSessionDirectoryScanPadding(state.sessionsDir);
      const outsideSessions = path.join(root, "outside-sessions");
      const admittedSessions = path.join(root, "admitted-sessions");
      await mkdir(outsideSessions);

      const outcome = listSessionIds(state).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDirectoryWatch(state.sessionsDir);
      await rename(state.sessionsDir, admittedSessions);
      await symlink(outsideSessions, state.sessionsDir, "dir");

      expect(String(await outcome)).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects global sessions-root replacement between listing and session admission", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-global-load-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "load-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      await addDirectoryScanPadding(machineDirectory);
      const outsideSessions = path.join(root, "outside-sessions");
      const admittedSessions = path.join(root, "admitted-sessions");
      await mkdir(outsideSessions);

      const outcome = listSessions(state).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDirectoryWatch(state.sessionsDir);
      await rename(state.sessionsDir, admittedSessions);
      await symlink(outsideSessions, state.sessionsDir, "dir");

      expect(String(await outcome)).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports global sessions-root replacement during integrity admission", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-global-integrity-race-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "integrity-race",
      });
      const paths = sessionPaths(state, descriptor.sessionId);
      const machineDirectory = path.join(paths.eventsDir, (await readdir(paths.eventsDir))[0]);
      await addDirectoryScanPadding(machineDirectory);
      const outsideSessions = path.join(root, "outside-sessions");
      const admittedSessions = path.join(root, "admitted-sessions");
      await mkdir(outsideSessions);

      const outcome = inspectSessionIntegrity(state);
      await waitForDirectoryWatch(state.sessionsDir);
      await rename(state.sessionsDir, admittedSessions);
      await symlink(outsideSessions, state.sessionsDir, "dir");

      const inspection = await outcome;
      expect(inspection.ok).toBe(false);
      expect(inspection.issues.join("\n")).toMatch(
        /canonical session directory (must be physical|changed during admission)|ENOENT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("immutable events deterministically rebuild tampered or missing projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-replay-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "replay-session",
      });
      await runSessionTurn(state, new FakeProviderAdapter(), descriptor, { prompt: "canonical" });
      const expectedState = await loadSessionState(state, descriptor.sessionId);
      const expectedTranscript = await loadTranscript(state, descriptor.sessionId);
      const paths = sessionPaths(state, descriptor.sessionId);

      await Bun.write(paths.stateFile, '{"schemaVersion":1,"sessionId":"tampered","turnCount":999}\n');
      await Bun.write(paths.transcriptFile, '{"schemaVersion":1,"sessionId":"tampered","messages":[]}\n');
      expect(await loadSessionState(state, descriptor.sessionId)).toEqual(expectedState);
      expect(await loadTranscript(state, descriptor.sessionId)).toEqual(expectedTranscript);

      await rm(paths.stateFile, { force: true });
      await rm(paths.transcriptFile, { force: true });
      expect(await loadSessionState(state, descriptor.sessionId)).toEqual(expectedState);
      expect(await loadTranscript(state, descriptor.sessionId)).toEqual(expectedTranscript);

      const events = await loadSessionEvents(state, descriptor.sessionId);
      expect(events.map((event) => event.type)).toEqual([
        "session.created",
        "turn.started",
        "message.appended",
        "message.appended",
        "turn.completed",
      ]);
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.data.usage : undefined).toEqual({
        tokensIn: 24,
        tokensOut: 15,
      });

      if (process.platform !== "win32") {
        const manifest = JSON.parse(await readFile(path.join(state.stateDir, "manifest.json"), "utf8")) as {
          machineId: string;
        };
        const machineDirectory = path.join(paths.eventsDir, manifest.machineId);
        const eventFiles = await readdir(machineDirectory);
        expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.eventsDir)).mode & 0o777).toBe(0o700);
        expect((await stat(machineDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.stateFile)).mode & 0o777).toBe(0o600);
        expect((await stat(paths.transcriptFile)).mode & 0o777).toBe(0o600);
        for (const eventFile of eventFiles) {
          expect((await stat(path.join(machineDirectory, eventFile))).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("event integrity failures are rejected instead of trusting projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-integrity-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test", sessionId: "integrity" });
      await runSessionTurn(state, new FakeProviderAdapter(), descriptor, { prompt: "hello" });
      const paths = sessionPaths(state, descriptor.sessionId);
      const manifest = JSON.parse(await readFile(path.join(state.stateDir, "manifest.json"), "utf8")) as {
        machineId: string;
      };
      const machineDirectory = path.join(paths.eventsDir, manifest.machineId);
      const eventFile = path.join(machineDirectory, (await readdir(machineDirectory)).sort()[1]);
      const event = JSON.parse(await readFile(eventFile, "utf8")) as { eventHash: string };
      event.eventHash = "0".repeat(64);
      await Bun.write(eventFile, `${JSON.stringify(event, null, 2)}\n`);

      expect(loadTranscript(state, descriptor.sessionId)).rejects.toThrow("session event hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read-only integrity inspection distinguishes projection drift from event tampering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-inspection-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test", sessionId: "inspection" });
      await runSessionTurn(state, new FakeProviderAdapter(), descriptor, { prompt: "canonical" });
      expect((await inspectSessionIntegrity(state)).ok).toBe(true);

      const paths = sessionPaths(state, descriptor.sessionId);
      await Bun.write(paths.transcriptFile, "forged\n");
      const drift = await inspectSessionIntegrity(state);
      expect(drift.eventIntegrity).toBe(true);
      expect(drift.projectionIntegrity).toBe(false);
      expect(await Bun.file(paths.transcriptFile).text()).toBe("forged\n");

      await loadTranscript(state, descriptor.sessionId);
      const manifest = JSON.parse(await readFile(path.join(state.stateDir, "manifest.json"), "utf8")) as { machineId: string };
      const eventFile = path.join(paths.eventsDir, manifest.machineId, (await readdir(path.join(paths.eventsDir, manifest.machineId))).sort()[0]);
      const event = JSON.parse(await readFile(eventFile, "utf8")) as { eventHash: string };
      event.eventHash = "0".repeat(64);
      await Bun.write(eventFile, `${JSON.stringify(event, null, 2)}\n`);
      const tampered = await inspectSessionIntegrity(state);
      expect(tampered.eventIntegrity).toBe(false);
      expect(tampered.issues.join("\n")).toContain("hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects the retired default model sentinel at creation and switch boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-model-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await expect(createSession(state, { provider: "fake", model: "default" })).rejects.toThrow(
        "retired default model sentinel",
      );
      const descriptor = await createSession(state, { provider: "fake", model: "test" });
      await expect(switchSessionProvider(state, descriptor.sessionId, "fake", "default")).rejects.toThrow(
        "retired default model sentinel",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects session id collisions and projection-only retired sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-collision-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await createSession(state, { provider: "fake", model: "test", sessionId: "same-id" });
      expect(createSession(state, { provider: "fake", model: "test", sessionId: "same-id" })).rejects.toThrow(
        "session id collision",
      );

      const retired = sessionPaths(state, "retired-session");
      await mkdir(retired.dir, { recursive: true, mode: 0o700 });
      await Bun.write(retired.stateFile, '{"schemaVersion":1,"sessionId":"retired-session"}\n');
      await Bun.write(retired.transcriptFile, '{"schemaVersion":1,"sessionId":"retired-session","messages":[]}\n');
      expect(loadSessionState(state, "retired-session")).rejects.toThrow("retired projections are not loadable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent turns serialize without truncating messages or usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-concurrent-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "concurrent",
        model: "test",
        sessionId: "concurrent-session",
      });
      const adapter = new (class implements ProviderAdapter {
        readonly id = "concurrent";
        readonly displayName = "Concurrent";
        readonly supportsStreaming = false;
        async startSession(): Promise<void> {}
        async continueSession(_descriptor: SessionDescriptor, _transcript: SessionTranscript): Promise<void> {}
        async runTurn(
          _descriptor: SessionDescriptor,
          _transcript: SessionTranscript,
          request: TurnRequest,
        ): Promise<TurnResult> {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            role: "assistant",
            content: `reply:${request.prompt}`,
            usage: { tokensIn: request.prompt.length, tokensOut: request.prompt.length + 6 },
          };
        }
      })();

      await Promise.all([
        runSessionTurn(state, adapter, descriptor, { prompt: "alpha" }),
        runSessionTurn(state, adapter, descriptor, { prompt: "beta" }),
      ]);
      const sessionState = await loadSessionState(state, descriptor.sessionId);
      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(sessionState?.turnCount).toBe(2);
      expect(transcript?.messages).toHaveLength(4);
      expect(transcript?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(
        transcript?.messages.filter((message) => message.role === "user").map((message) => message.content).sort(),
      ).toEqual(["alpha", "beta"]);
      expect((await loadSessionEvents(state, descriptor.sessionId)).filter((event) => event.type === "turn.completed")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session lock heartbeat advances the authoritative lease before ordered handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-heartbeat-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "heartbeat-session",
      });
      const options = { leaseMs: 10_000, heartbeatMs: 100, waitMs: 3_000 };
      const order: string[] = [];
      let reportRenewal!: () => void;
      const renewalObserved = new Promise<void>((resolve) => {
        reportRenewal = resolve;
      });
      let releaseFirst!: () => void;
      const firstMayLeave = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let startSecond!: () => void;
      const secondMayStart = new Promise<void>((resolve) => {
        startSecond = resolve;
      });
      let reportSecondAttemptStarted!: () => void;
      const secondAttemptStarted = new Promise<void>((resolve) => {
        reportSecondAttemptStarted = resolve;
      });
      let reportSecondEntered!: () => void;
      const secondCallbackEntered = new Promise<void>((resolve) => {
        reportSecondEntered = resolve;
      });

      const first = withSessionWriteLock(
        state,
        descriptor.sessionId,
        async (lock) => {
          order.push("first:entered");
          const database = new Database(renewableLockDatabasePath(state), { readonly: true });
          try {
            const lease = database.query<{ expiresAt: number }, [string]>(
              "SELECT expires_at AS expiresAt FROM renewable_leases WHERE key = ?1",
            );
            const key = `session:${descriptor.sessionId}`;
            const initialExpiresAt = lease.get(key)?.expiresAt;
            if (!initialExpiresAt) throw new Error(`active session lease is missing: ${key}`);

            const deadline = Date.now() + 5_000;
            let renewedExpiresAt = initialExpiresAt;
            while (renewedExpiresAt <= initialExpiresAt && Date.now() < deadline) {
              await Bun.sleep(10);
              renewedExpiresAt = lease.get(key)?.expiresAt ?? 0;
            }
            expect(renewedExpiresAt).toBeGreaterThan(initialExpiresAt);
            reportRenewal();
            await firstMayLeave;
            await lock.verify();
            order.push("first:leaving");
          } finally {
            database.close();
          }
        },
        options,
      );
      let second: Promise<void> | undefined;
      try {
        await Promise.race([
          renewalObserved,
          first.then(() => {
            throw new Error("first session owner exited before its heartbeat renewed the lease");
          }),
        ]);
        second = (async () => {
          await secondMayStart;
          const attempt = withSessionWriteLock(
            state,
            descriptor.sessionId,
            async () => {
              order.push("second:entered");
              reportSecondEntered();
            },
            options,
          );
          reportSecondAttemptStarted();
          return attempt;
        })();
        startSecond();
        await secondAttemptStarted;
        const blockedProbe = await Promise.race([
          secondCallbackEntered.then(() => "second-entered" as const),
          second.then(() => "second-completed" as const),
          first.then(() => "first-exited" as const),
          Bun.sleep(250).then(() => "blocked" as const),
        ]);
        expect(blockedProbe).toBe("blocked");
        expect(order).toEqual(["first:entered"]);
        releaseFirst();
        await Promise.all([first, second]);
      } finally {
        releaseFirst();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      expect(order).toEqual(["first:entered", "first:leaving", "second:entered"]);
      if (process.platform !== "win32") {
        expect((await stat(renewableLockDatabasePath(state))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lost session ownership fails closed before a provider response is persisted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-lock-loss-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "lost-provider-boundary",
      });

      await expect(
        withSessionWriteTransaction(
          state,
          descriptor.sessionId,
          async (transaction) => {
            const turnId = await transaction.beginTurn();
            await transaction.appendMessage(turnId, { role: "user", content: "before-provider" });
            const leases = new Database(renewableLockDatabasePath(state));
            try {
              const replaced = leases.query(
                "UPDATE renewable_leases SET token = ?1, expires_at = 0 WHERE key = ?2",
              ).run("replacement-owner", `session:${descriptor.sessionId}`);
              expect(replaced.changes).toBe(1);
            } finally {
              leases.close();
            }
            await transaction.verify();
            await transaction.appendMessage(turnId, { role: "assistant", content: "must-not-persist" });
            await transaction.completeTurn(turnId);
          },
          { leaseMs: 5_000, heartbeatMs: 1_000, waitMs: 1_000 },
        ),
      ).rejects.toThrow("ownership was lost");

      const events = await loadSessionEvents(state, descriptor.sessionId);
      expect(events.filter((event) => event.type === "message.appended").map((event) => event.data)).toEqual([
        { turnId: expect.any(String), message: { role: "user", content: "before-provider" } },
      ]);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI session run creates session and persists transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-cli-session-"));
    try {
      const run = await runAgents(root, ["session", "run", "--provider", "fake", "--model", "test", "hello"]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toContain("fake: hello");
      expect(run.stderr).toContain("session:");

      const list = await runAgents(root, ["session", "list", "--json"]);
      expect(list.code).toBe(0);
      const sessions = JSON.parse(list.stdout) as Array<{ sessionId: string; provider: string; model: string }>;
      expect(sessions.length).toBe(1);
      expect(sessions[0].provider).toBe("fake");
      expect(sessions[0].model).toBe("test");

      const show = await runAgents(root, ["session", "show", sessions[0].sessionId, "--json"]);
      expect(show.code).toBe(0);
      const shown = JSON.parse(show.stdout) as { state: { turnCount: number }; transcript: { messages: Array<{ role: string }> } };
      expect(shown.state.turnCount).toBe(1);
      expect(shown.transcript.messages.length).toBe(2);
      expect(shown.transcript.messages[0].role).toBe("user");
      expect(shown.transcript.messages[1].role).toBe("assistant");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI session run records the invocation cwd instead of the distribution root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-cli-session-workdir-"));
    const invocationRoot = path.join(root, "task");
    const distributionRoot = path.join(root, "distribution");
    const stateRoot = path.join(root, "state");
    try {
      await Promise.all([mkdir(invocationRoot), mkdir(distributionRoot)]);
      const env = { ANDROMEDA_HOME: stateRoot, ANDROMEDA_ROOT: distributionRoot };

      const run = await runAgents(
        invocationRoot,
        ["session", "run", "--provider", "fake", "--model", "test", "hello"],
        env,
      );
      expect(run.code).toBe(0);
      const sessionId = run.stderr.trim().replace("session: ", "");

      const show = await runAgents(invocationRoot, ["session", "show", sessionId, "--json"], env);
      expect(show.code).toBe(0);
      const shown = JSON.parse(show.stdout) as { state: { workdir: string } };
      expect(shown.state.workdir).toBe(invocationRoot);
      expect(shown.state.workdir).not.toBe(distributionRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI session run continues existing session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-cli-session-cont-"));
    try {
      const first = await runAgents(root, ["session", "run", "--provider", "fake", "--model", "test", "first"]);
      expect(first.code).toBe(0);
      const sessionId = first.stderr.trim().replace("session: ", "");

      const second = await runAgents(root, ["session", "run", "--session", sessionId, "second"]);
      expect(second.code).toBe(0);
      expect(second.stdout.trim()).toContain("fake: second");

      const show = await runAgents(root, ["session", "show", sessionId, "--json"]);
      const shown = JSON.parse(show.stdout) as { state: { turnCount: number }; transcript: { messages: Array<{ role: string; content: string }> } };
      expect(shown.state.turnCount).toBe(2);
      expect(shown.transcript.messages.length).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("andromeda run / sessions CLI", () => {
  test("run starts a session and prints the reply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-"));
    try {
      const run = await runAgents(root, ["run", "--provider", "fake", "--model", "test", "hello"]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toContain("fake: hello");
      expect(run.stderr).toContain("session:");

      const list = await runAgents(root, ["sessions", "list", "--json"]);
      expect(list.code).toBe(0);
      const sessions = JSON.parse(list.stdout) as Array<{
        sessionId: string;
        provider: string;
        model: string;
        mode: string;
        updated: string;
      }>;
      expect(sessions.length).toBe(1);
      expect(sessions[0].provider).toBe("fake");
      expect(sessions[0].model).toBe("test");
      expect(sessions[0].mode).toBe("default");
      expect(sessions[0].updated).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run records the invocation cwd instead of the distribution root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-workdir-"));
    const invocationRoot = path.join(root, "task");
    const distributionRoot = path.join(root, "distribution");
    const stateRoot = path.join(root, "state");
    try {
      await Promise.all([mkdir(invocationRoot), mkdir(distributionRoot)]);
      const env = { ANDROMEDA_HOME: stateRoot, ANDROMEDA_ROOT: distributionRoot };

      const run = await runAgents(invocationRoot, ["run", "--provider", "fake", "--model", "test", "hello"], env);
      expect(run.code).toBe(0);
      const sessionId = run.stderr.trim().replace("session: ", "");

      const show = await runAgents(invocationRoot, ["session", "show", sessionId, "--json"], env);
      expect(show.code).toBe(0);
      const shown = JSON.parse(show.stdout) as { state: { workdir: string } };
      expect(shown.state.workdir).toBe(invocationRoot);
      expect(shown.state.workdir).not.toBe(distributionRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run uses provider/model/mode defaults from config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-config-"));
    try {
      const configPath = path.join(root, ".andromeda", "config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await Bun.write(
        configPath,
        JSON.stringify({ schemaVersion: 1, defaultProvider: "fake", defaultModel: "from-config", defaultMode: "orchestrator" }),
      );

      const run = await runAgents(root, ["run", "configured"]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toContain("fake: configured");

      const list = await runAgents(root, ["sessions", "list", "--json"]);
      const sessions = JSON.parse(list.stdout) as Array<{ model: string; mode: string }>;
      expect(sessions[0].model).toBe("from-config");
      expect(sessions[0].mode).toBe("orchestrator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sessions resume continues a session with the fake adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-resume-"));
    try {
      const first = await runAgents(root, ["run", "--provider", "fake", "--model", "test", "first"]);
      expect(first.code).toBe(0);
      const sessionId = first.stderr.trim().replace("session: ", "");

      const resumed = await runAgents(root, ["sessions", "resume", sessionId, "second"]);
      expect(resumed.code).toBe(0);
      expect(resumed.stdout.trim()).toContain("fake: second");

      const show = await runAgents(root, ["session", "show", sessionId, "--json"]);
      const shown = JSON.parse(show.stdout) as {
        state: { turnCount: number };
        transcript: { messages: Array<{ role: string; content: string }> };
      };
      expect(shown.state.turnCount).toBe(2);
      expect(shown.transcript.messages.length).toBe(4);
      expect(shown.transcript.messages[3].content).toBe("fake: second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sessions resume preserves the original workdir from another invocation cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-resume-workdir-"));
    const firstInvocation = path.join(root, "first-task");
    const secondInvocation = path.join(root, "second-task");
    const distributionRoot = path.join(root, "distribution");
    const stateRoot = path.join(root, "state");
    try {
      await Promise.all([mkdir(firstInvocation), mkdir(secondInvocation), mkdir(distributionRoot)]);
      const env = { ANDROMEDA_HOME: stateRoot, ANDROMEDA_ROOT: distributionRoot };

      const first = await runAgents(
        firstInvocation,
        ["run", "--provider", "fake", "--model", "test", "first"],
        env,
      );
      expect(first.code).toBe(0);
      const sessionId = first.stderr.trim().replace("session: ", "");

      const resumed = await runAgents(secondInvocation, ["sessions", "resume", sessionId, "second"], env);
      expect(resumed.code).toBe(0);

      const show = await runAgents(secondInvocation, ["session", "show", sessionId, "--json"], env);
      expect(show.code).toBe(0);
      const shown = JSON.parse(show.stdout) as { state: { workdir: string; turnCount: number } };
      expect(shown.state.workdir).toBe(firstInvocation);
      expect(shown.state.workdir).not.toBe(secondInvocation);
      expect(shown.state.turnCount).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run without provider, model, or config fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-missing-"));
    try {
      const run = await runAgents(root, ["run", "no-defaults"]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("provider and model are required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("real adapter smoke test", () => {
  test("smokes the configured provider behind an env guard", async () => {
    const provider = process.env.ANDROMEDA_SESSION_SMOKE_PROVIDER;
    if (!provider) {
      expect(true).toBe(true);
      return;
    }
    const model = process.env.ANDROMEDA_SESSION_SMOKE_MODEL;
    if (!model) throw new Error("ANDROMEDA_SESSION_SMOKE_MODEL is required with ANDROMEDA_SESSION_SMOKE_PROVIDER");
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-smoke-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const adapter = providerSessionAdapter(provider, process.env.ANDROMEDA_SESSION_SMOKE_BINARY);
      const descriptor = await createSession(state, {
        provider: adapter.id,
        model,
      });
      const result = await runSessionTurn(state, adapter, descriptor, {
        prompt: "Reply with the single word 'ok' and nothing else.",
      });
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.messages.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
