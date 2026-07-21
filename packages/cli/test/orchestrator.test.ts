import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../src/state";
import {
  appendOrchestratorLedger,
  ensureOrchestratorState,
  initializeOrchestratorState,
  inspectOrchestratorIntegrity,
  orchestratorStateDir,
  orchestratorStateMarkdown,
  orchestratorSystemPrompt,
  parseStateMarkdown,
  readOrchestratorEvents,
  readOrchestratorState,
  startOrchestratorHeartbeat,
  writeOrchestratorHeartbeat,
} from "../src/orchestrator";
import { renewableLockDatabasePath } from "../src/state-lock";
import { loadTranscript } from "../../sdk/harness/session";

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
      ANDROMEDA_HOME: path.join(cwd, ".agents"),
      ANDROMEDA_ROOT: cwd,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("orchestrator state helpers", () => {
  test("orchestratorStateDir resolves under .agents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-dir-"));
    try {
      const state = sharedState(root);
      expect(orchestratorStateDir(state)).toBe(path.join(root, ".agents", "orchestrator"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ensureOrchestratorState creates the state dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-ensure-"));
    try {
      const state = sharedState(root);
      await ensureOrchestratorState(state);
      const info = await Bun.file(orchestratorStateDir(state)).stat();
      expect(info.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("initializeOrchestratorState projects the event-derived baton and heartbeat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-init-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      const doc = await readOrchestratorState(state);
      expect(doc).not.toBeNull();
      expect(doc?.baton.holder).toBe("session-1");
      expect(doc?.baton.provider).toBe("fake");
      expect(doc?.baton.model).toBe("test");
      expect(doc?.heartbeat.provider).toBe("fake");
      expect(doc?.heartbeat.model).toBe("test");
      expect(doc?.ledger).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writeOrchestratorHeartbeat updates heartbeat and preserves baton", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-beat-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await writeOrchestratorHeartbeat(state, "session-1", { provider: "codex", model: "latest" });
      const doc = await readOrchestratorState(state);
      expect(doc?.baton.holder).toBe("session-1");
      expect(doc?.heartbeat.provider).toBe("codex");
      expect(doc?.heartbeat.model).toBe("latest");
      expect(new Date(doc?.heartbeat.lastBeatAt ?? 0).getTime()).toBeGreaterThan(0);
      expect(new Date(doc?.heartbeat.nextCheckAt ?? 0).getTime()).toBeGreaterThan(
        new Date(doc?.heartbeat.lastBeatAt ?? 0).getTime(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lifetime heartbeat renews ownership and records a clean release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-lifetime-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const controller = await startOrchestratorHeartbeat(
        state,
        "session-1",
        { provider: "fake", model: "test" },
        { intervalMs: 20 },
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      controller.assertHealthy();
      await controller.update({ provider: "codex", model: "gpt-test" });
      await controller.stop();

      const events = await readOrchestratorEvents(state);
      expect(events.filter((event) => event.type === "heartbeat.recorded").length).toBeGreaterThanOrEqual(2);
      expect(events.at(-1)?.type).toBe("baton.released");
      const document = await readOrchestratorState(state);
      expect(document?.baton.active).toBe(false);
      expect(document?.baton.holder).toBe("session-1");
      expect(document?.heartbeat).toMatchObject({ provider: "codex", model: "gpt-test" });
      expect(await inspectOrchestratorIntegrity(state)).toMatchObject({ ok: true, authority: "released" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("integrity inspection fails an expired active authority without changing projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-expired-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      const statePath = path.join(state.orchestratorDir, "state.json");
      const before = await readFile(statePath, "utf8");
      const inspection = await inspectOrchestratorIntegrity(state, new Date("2100-01-01T00:00:00.000Z"));
      expect(inspection.ok).toBe(false);
      expect(inspection.authority).toBe("expired");
      expect(inspection.issues.join("\n")).toContain("active orchestrator baton expired");
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("appendOrchestratorLedger appends an event and updates the projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-ledger-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await appendOrchestratorLedger(state, "session-1", {
        action: "dispatch",
        repo: "marius-patrik/Andromeda",
        issue: 114,
        note: "orchestrator mode",
      });
      const doc = await readOrchestratorState(state);
      expect(doc?.ledger).toHaveLength(1);
      expect(doc?.ledger[0].action).toBe("dispatch");
      expect(doc?.ledger[0].repo).toBe("marius-patrik/Andromeda");
      expect(doc?.ledger[0].issue).toBe(114);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orchestrator state markdown round-trips", () => {
    const doc = {
      baton: {
        active: true,
        holder: "s1",
        since: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:05:00.000Z",
        provider: "fake",
        model: "m1",
      },
      heartbeat: { lastBeatAt: "2026-01-01T00:01:00.000Z", nextCheckAt: "2026-01-01T00:02:00.000Z", provider: "fake", model: "m1" },
      ledger: [{ at: "2026-01-01T00:01:00.000Z", action: "observe", repo: "owner/repo", issue: 7, note: "ok" }],
    };
    const md = orchestratorStateMarkdown(doc);
    expect(md).toContain("# Orchestrator State");
    expect(md).toContain("- active: true");
    expect(md).toContain("- holder: s1");
    expect(md).toContain("- expiresAt: 2026-01-01T00:05:00.000Z");
    expect(md).toContain("| 2026-01-01T00:01:00.000Z | observe | owner/repo | 7 | ok |");

    const parsed = parseStateMarkdown(md);
    expect(parsed.baton).toEqual(doc.baton);
    expect(parsed.heartbeat).toEqual(doc.heartbeat);
    expect(parsed.ledger).toEqual(doc.ledger);
  });

  test("immutable events rebuild tampered orchestrator projections with private modes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-replay-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await writeOrchestratorHeartbeat(state, "session-1", { provider: "codex", model: "latest" });
      await appendOrchestratorLedger(state, "session-1", { action: "observe", note: "healthy" });
      const expected = await readOrchestratorState(state);
      const events = await readOrchestratorEvents(state);
      expect(events.map((event) => event.type)).toEqual([
        "orchestrator.initialized",
        "heartbeat.recorded",
        "ledger.appended",
      ]);

      const stateFile = path.join(state.orchestratorDir, "state.json");
      const markdownFile = path.join(state.orchestratorDir, "STATE.md");
      await Bun.write(stateFile, '{"baton":{"holder":"tampered"}}\n');
      await Bun.write(markdownFile, "# tampered\n");
      expect(await readOrchestratorState(state)).toEqual(expected);
      expect(await Bun.file(markdownFile).text()).toContain("Generated projection from immutable orchestrator events");
      expect(await Bun.file(markdownFile).text()).toContain("- holder: session-1");

      if (process.platform !== "win32") {
        const manifest = JSON.parse(await readFile(path.join(state.stateDir, "manifest.json"), "utf8")) as {
          machineId: string;
        };
        const eventsDirectory = path.join(state.orchestratorDir, "events");
        const machineDirectory = path.join(eventsDirectory, manifest.machineId);
        expect((await stat(state.orchestratorDir)).mode & 0o777).toBe(0o700);
        expect((await stat(eventsDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(machineDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
        expect((await stat(markdownFile)).mode & 0o777).toBe(0o600);
        for (const eventFile of await readdir(machineDirectory)) {
          expect((await stat(path.join(machineDirectory, eventFile))).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orchestrator event integrity failures are rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-integrity-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await writeOrchestratorHeartbeat(state, "session-1", { provider: "fake", model: "test" });
      const manifest = JSON.parse(await readFile(path.join(state.stateDir, "manifest.json"), "utf8")) as {
        machineId: string;
      };
      const machineDirectory = path.join(state.orchestratorDir, "events", manifest.machineId);
      const eventFile = path.join(machineDirectory, (await readdir(machineDirectory)).sort()[1]);
      const event = JSON.parse(await readFile(eventFile, "utf8")) as { eventHash: string };
      event.eventHash = "0".repeat(64);
      await Bun.write(eventFile, `${JSON.stringify(event, null, 2)}\n`);
      expect(readOrchestratorState(state)).rejects.toThrow("orchestrator event hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent ledger writers serialize and an unexpired baton rejects takeover", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-concurrent-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          appendOrchestratorLedger(state, "session-1", { action: "observe", note: `entry-${index}` }),
        ),
      );
      const document = await readOrchestratorState(state);
      expect(document?.ledger).toHaveLength(8);
      expect(document?.ledger.map((entry) => entry.note).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `entry-${index}`).sort(),
      );
      expect(initializeOrchestratorState(state, "session-2", "claude", "latest")).rejects.toThrow(
        "orchestrator baton is held by session-1",
      );
      expect((await readOrchestratorEvents(state)).filter((event) => event.type === "ledger.appended")).toHaveLength(8);
      if (process.platform !== "win32") {
        expect((await stat(renewableLockDatabasePath(state))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("andromeda run --mode orchestrator", () => {
  test("mode loading creates an orchestrator session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-orch-mode-"));
    try {
      const run = await runAgents(root, ["run", "--provider", "fake", "--model", "test", "--mode", "orchestrator", "hello"]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toContain("fake: hello");
      expect(run.stderr).toContain("session:");

      const list = await runAgents(root, ["sessions", "list", "--json"]);
      const sessions = JSON.parse(list.stdout) as Array<{ mode: string }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].mode).toBe("orchestrator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("state-dir wiring creates .agents/orchestrator/STATE.md", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-orch-state-"));
    try {
      const run = await runAgents(root, ["run", "--provider", "fake", "--model", "test", "--mode", "orchestrator", "hello"]);
      expect(run.code).toBe(0);

      const state = sharedState(root);
      const stateFile = path.join(state.orchestratorDir, "STATE.md");
      const text = await Bun.file(stateFile).text();
      expect(text).toContain("# Orchestrator State");
      expect(text).toContain("## Baton");
      expect(text).toContain("## Heartbeat");
      expect(text).toContain("## Ledger");
      expect(text).toContain("- provider: fake/test");
      expect(text).toContain("- active: false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skill-contract injection adds orchestrator system prompt to transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-run-orch-prompt-"));
    try {
      const run = await runAgents(root, ["run", "--provider", "fake", "--model", "test", "--mode", "orchestrator", "hello"]);
      expect(run.code).toBe(0);
      const sessionId = run.stderr.trim().replace("session: ", "");

      const state = sharedState(root);
      const transcript = await loadTranscript(state, sessionId);
      expect(transcript).not.toBeNull();
      const systemMessages = transcript?.messages.filter((m) => m.role === "system") ?? [];
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).toContain("orchestrator session");
      expect(systemMessages[0].content).toContain(".agents/orchestrator/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orchestrator system prompt is available and non-empty", () => {
    const prompt = orchestratorSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("one personal-agent identity");
    expect(prompt).toContain("Delegate bounded independent work");
    expect(prompt).toContain(".agents/orchestrator/");
    expect(prompt).toContain("Never edit STATE.md or state.json directly");
  });
});
