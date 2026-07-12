import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionTranscript, TurnRequest } from "../../harness/session";
import {
  buildProviderArgs,
  codexSessionAdapter,
  loadCanonicalStartup,
  providerBinarySafetyReason,
  withCanonicalStartup,
} from "../src/session-adapters";
import type { SessionDescriptor } from "../../harness/session";
import { ensureSharedState, sharedStateAt } from "../src/state";
import { rememberMemory } from "../src/memory";

function transcript(messages: SessionTranscript["messages"] = []): SessionTranscript {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    provider: "codex",
    model: "gpt-test",
    mode: "chat",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    messages,
  };
}

const request: TurnRequest = { prompt: "next question" };

describe("provider CLI session arguments", () => {
  test("uses each installed CLI's noninteractive form", () => {
    const current = transcript([{ role: "user", content: request.prompt }]);
    const prompt = "User: next question\n\nAssistant:";

    expect(buildProviderArgs("codex", "gpt-test", request, current)).toEqual(["exec", "--model", "gpt-test", prompt]);
    expect(buildProviderArgs("kimi", "kimi-test", request, current)).toEqual(["--model", "kimi-test", "--prompt", prompt]);
    expect(buildProviderArgs("claude", "claude-test", request, current)).toEqual(["--print", "--model", "claude-test", prompt]);
    expect(buildProviderArgs("agy", "agy-test", request, current)).toEqual(["--print", "--model", "agy-test", prompt]);
  });

  test("passes an explicitly selected model for every provider", () => {
    const empty = transcript();

    expect(buildProviderArgs("codex", "gpt-test", request, empty)).toEqual([
      "exec",
      "--model",
      "gpt-test",
      request.prompt,
    ]);
    expect(buildProviderArgs("kimi", "kimi-test", request, empty)).toEqual([
      "--model",
      "kimi-test",
      "--prompt",
      request.prompt,
    ]);
    expect(buildProviderArgs("claude", "claude-test", request, empty)).toEqual([
      "--print",
      "--model",
      "claude-test",
      request.prompt,
    ]);
    expect(buildProviderArgs("agy", "agy-test", request, empty)).toEqual([
      "--print",
      "--model",
      "agy-test",
      request.prompt,
    ]);
  });

  test("rejects missing and retired model selections", () => {
    const empty = transcript();
    expect(() => buildProviderArgs("codex", "", request, empty)).toThrow("concrete non-empty identifier");
    expect(() => buildProviderArgs("codex", "default", request, empty)).toThrow("retired default model sentinel");
  });

  test("renders the current user turn only once", () => {
    const current = transcript([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "answer" },
      { role: "user", content: request.prompt },
    ]);

    const args = buildProviderArgs("codex", "gpt-test", request, current);
    expect(args[3]).toBe("User: earlier\n\nAssistant: answer\n\nUser: next question\n\nAssistant:");
    expect(args[3].match(/next question/g)?.length).toBe(1);
  });
});

describe("canonical startup projection", () => {
  test("injects canonical Agent OS startup exactly once for every provider prompt", () => {
    const startup = "# Canonical startup context\n\n- product-count = 1";
    const once = withCanonicalStartup(transcript(), startup);
    const twice = withCanonicalStartup(once, startup);
    expect(twice.messages.filter((message) => message.content === startup)).toHaveLength(1);

    for (const provider of ["codex", "kimi", "claude", "agy"] as const) {
      const args = buildProviderArgs(provider, `${provider}-test`, request, twice);
      expect(args.join("\n")).toContain(startup);
      expect(args.join("\n").match(/product-count = 1/g)?.length).toBe(1);
    }
  });

  test("loads only canonical identity, memory, and capabilities while ignoring provider-native history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-startup-view-"));
    try {
      const stateDir = path.join(root, ".agents");
      const canonical = path.join(stateDir, "memory", "views", "startup.md");
      const state = sharedStateAt(root, stateDir, root);
      await ensureSharedState(state);
      await Bun.write(path.join(stateDir, "identity", "persona.md"), "# Rommie\n");
      await Bun.write(path.join(stateDir, "identity", "capabilities.md"), "# Canonical capabilities\n\n## probe\n");
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "startup-proof",
        value: "CANONICAL-CONTEXT",
        evidence: {
          uri: "user://instruction/startup-proof",
          contentHash: "a".repeat(64),
          sourceClass: "verified",
          confidence: 1,
        },
      });
      await Bun.write(path.join(root, ".codex", "memories", "MEMORY.md"), "CONTRADICTORY-PROVIDER-HISTORY\n");
      const descriptor: SessionDescriptor = {
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-test",
        mode: "chat",
        workdir: root,
        stateDir,
      };

      const startup = await loadCanonicalStartup(descriptor);
      expect(startup).toContain("# Rommie");
      expect(startup).toContain("CANONICAL-CONTEXT");
      expect(startup).toContain("## probe");
      expect(startup).not.toContain("CONTRADICTORY-PROVIDER-HISTORY");
      await Bun.write(canonical, "FORGED-PROJECTION\n");
      const repaired = await loadCanonicalStartup(descriptor);
      expect(repaired).toContain("CANONICAL-CONTEXT");
      expect(repaired).not.toContain("FORGED-PROJECTION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("provider binary recursion safety", () => {
  test("rejects shared .agents/bin manager entrypoints", () => {
    const shim = path.join(os.tmpdir(), "home", ".agents", "bin", "codex");
    expect(providerBinarySafetyReason(shim)).toContain("manager shim");
    expect(() => codexSessionAdapter(shim)).toThrow("refusing recursive provider binary");
  });

  test("rejects retired manager-delegating shims outside .agents/bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-shim-"));
    const shim = path.join(root, "codex");
    try {
      await writeFile(shim, "#!/bin/sh\nexec /opt/agents/bin/rommie cli codex \"$@\"\n");
      expect(providerBinarySafetyReason(shim)).toContain("retired manager shim");
      expect(() => codexSessionAdapter(shim)).toThrow("refusing recursive provider binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects any provider executable outside its canonical home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-outside-"));
    const binary = path.join(root, "codex");
    try {
      await writeFile(binary, "#!/bin/sh\nexit 0\n");
      expect(() => codexSessionAdapter(binary)).toThrow("outside the canonical Agent OS provider home");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("provider adapter state ownership", () => {
  test("does not create provider-owned session directories outside the canonical event store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-session-state-"));
    try {
      const previousHome = process.env.AGENTS_HOME;
      process.env.AGENTS_HOME = path.join(root, "state");
      try {
        const binary = path.join(process.env.AGENTS_HOME, "clis", "codex", "bin", "codex");
        await Bun.write(binary, "#!/bin/sh\nexit 0\n");
        const adapter = codexSessionAdapter(binary);
        const descriptor: SessionDescriptor = {
          sessionId: "canonical-only",
          provider: "codex",
          model: "gpt-test",
          mode: "chat",
          workdir: root,
          stateDir: path.join(root, "state"),
        };
        await adapter.startSession(descriptor);
        expect(await Bun.file(path.join(descriptor.stateDir, descriptor.sessionId)).exists()).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.AGENTS_HOME;
        else process.env.AGENTS_HOME = previousHome;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
