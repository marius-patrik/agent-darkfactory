import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../../src/manager/state";
import {
  createSession,
  inspectSessionIntegrity,
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
} from "../../src/harness/session";
import { FakeProviderAdapter } from "../../src/harness/session-adapters";
import { providerSessionAdapter } from "../../src/manager/session-adapters";
import { renewableLockDatabasePath } from "../../src/manager/state-lock";

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliPath = path.join(repoRoot, "src", "manager", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("AGENTS_")) delete copy[key];
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
      AGENTS_HOME: path.join(cwd, ".agents"),
      AGENTS_ROOT: cwd,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
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

  test("session lock heartbeat prevents reclaim during a provider-length operation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-heartbeat-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, {
        provider: "fake",
        model: "test",
        sessionId: "heartbeat-session",
      });
      const options = { leaseMs: 120, heartbeatMs: 20, waitMs: 1_000 };
      const order: string[] = [];

      const first = withSessionWriteLock(
        state,
        descriptor.sessionId,
        async (lock) => {
          order.push("first:entered");
          await new Promise((resolve) => setTimeout(resolve, 300));
          await lock.verify();
          order.push("first:leaving");
        },
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      const second = withSessionWriteLock(
        state,
        descriptor.sessionId,
        async () => {
          order.push("second:entered");
        },
        options,
      );

      await Promise.all([first, second]);
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
            Bun.sleepSync(120);
            await transaction.verify();
            await transaction.appendMessage(turnId, { role: "assistant", content: "must-not-persist" });
            await transaction.completeTurn(turnId);
          },
          { leaseMs: 80, heartbeatMs: 20, waitMs: 1_000 },
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

describe("agents run / sessions CLI", () => {
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

  test("run uses provider/model/mode defaults from config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-config-"));
    try {
      const configPath = path.join(root, ".agents", "config.json");
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
    const provider = process.env.AGENTS_SESSION_SMOKE_PROVIDER;
    if (!provider) {
      expect(true).toBe(true);
      return;
    }
    const model = process.env.AGENTS_SESSION_SMOKE_MODEL;
    if (!model) throw new Error("AGENTS_SESSION_SMOKE_MODEL is required with AGENTS_SESSION_SMOKE_PROVIDER");
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-smoke-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const adapter = providerSessionAdapter(provider, process.env.AGENTS_SESSION_SMOKE_BINARY);
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
