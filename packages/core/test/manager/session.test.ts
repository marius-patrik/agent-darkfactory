import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sharedState } from "../../src/manager/state";
import {
  createSession,
  listSessions,
  loadSessionState,
  loadTranscript,
  runSessionTurn,
  streamSessionTurn,
  switchSessionProvider,
} from "../../src/harness/session";
import { FakeProviderAdapter } from "../../src/harness/session-adapters";
import { providerSessionAdapter } from "../../src/manager/session-adapters";

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
      await mkdir(state.sessionsDir, { recursive: true });
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
      await mkdir(state.sessionsDir, { recursive: true });
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
      await mkdir(state.sessionsDir, { recursive: true });
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
      await mkdir(state.sessionsDir, { recursive: true });
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
      await mkdir(state.sessionsDir, { recursive: true });
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
      await mkdir(state.sessionsDir, { recursive: true });
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
        JSON.stringify({ defaultProvider: "fake", defaultModel: "from-config", defaultMode: "orchestrator" }),
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-session-smoke-"));
    try {
      const state = sharedState(root);
      await mkdir(state.sessionsDir, { recursive: true });
      const adapter = providerSessionAdapter(provider, process.env.AGENTS_SESSION_SMOKE_BINARY);
      const descriptor = await createSession(state, {
        provider: adapter.id,
        model: process.env.AGENTS_SESSION_SMOKE_MODEL ?? "default",
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
