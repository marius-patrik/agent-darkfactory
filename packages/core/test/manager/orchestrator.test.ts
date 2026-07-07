import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sharedState } from "../../src/manager/state";
import {
  appendOrchestratorLedger,
  ensureOrchestratorState,
  initializeOrchestratorState,
  orchestratorStateDir,
  orchestratorStateMarkdown,
  orchestratorSystemPrompt,
  parseStateMarkdown,
  readOrchestratorState,
  writeOrchestratorHeartbeat,
} from "../../src/manager/orchestrator";
import { loadTranscript } from "../../src/harness/session";

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

  test("initializeOrchestratorState writes STATE.md with baton and heartbeat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-init-"));
    try {
      const state = sharedState(root);
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

  test("appendOrchestratorLedger appends to STATE.md", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-orch-ledger-"));
    try {
      const state = sharedState(root);
      await initializeOrchestratorState(state, "session-1", "fake", "test");
      await appendOrchestratorLedger(state, "session-1", {
        action: "dispatch",
        repo: "marius-patrik/agents-manager",
        issue: 114,
        note: "orchestrator mode",
      });
      const doc = await readOrchestratorState(state);
      expect(doc?.ledger).toHaveLength(1);
      expect(doc?.ledger[0].action).toBe("dispatch");
      expect(doc?.ledger[0].repo).toBe("marius-patrik/agents-manager");
      expect(doc?.ledger[0].issue).toBe(114);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orchestrator state markdown round-trips", () => {
    const doc = {
      baton: { holder: "s1", since: "2026-01-01T00:00:00.000Z", provider: "fake", model: "m1" },
      heartbeat: { lastBeatAt: "2026-01-01T00:01:00.000Z", nextCheckAt: "2026-01-01T00:02:00.000Z", provider: "fake", model: "m1" },
      ledger: [{ at: "2026-01-01T00:01:00.000Z", action: "observe", repo: "owner/repo", issue: 7, note: "ok" }],
    };
    const md = orchestratorStateMarkdown(doc);
    expect(md).toContain("# Orchestrator State");
    expect(md).toContain("- holder: s1");
    expect(md).toContain("| 2026-01-01T00:01:00.000Z | observe | owner/repo | 7 | ok |");

    const parsed = parseStateMarkdown(md);
    expect(parsed.baton).toEqual(doc.baton);
    expect(parsed.heartbeat).toEqual(doc.heartbeat);
    expect(parsed.ledger).toEqual(doc.ledger);
  });
});

describe("agents run --mode orchestrator", () => {
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
    expect(prompt).toContain("DarkFactory");
    expect(prompt).toContain(".agents/orchestrator/");
  });
});
