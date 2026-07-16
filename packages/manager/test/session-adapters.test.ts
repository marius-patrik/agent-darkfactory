import { describe, expect, spyOn, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderAdapter, SessionEvent, SessionTranscript, TurnRequest } from "../../harness/session";
import { createSession, loadSessionEvents, loadTranscript, runSessionTurn, streamSessionTurn } from "../../harness/session";
import {
  agySessionAdapter,
  attestAgyNativeInvocation,
  attestClaudeNativeInvocation,
  attestCodexExecutionPolicy,
  buildProviderArgs,
  canonicalProviderEnv,
  claudeSessionAdapter,
  CliProviderAdapter,
  codexSessionAdapter,
  kimiSessionAdapter,
  loadCanonicalStartup,
  providerBinarySafetyReason,
  parseClaudeJsonResult,
  parseCodexJsonResult,
  resolveAgyModel,
  transcriptAsPrompt,
  withCanonicalStartup,
} from "../src/session-adapters";
import type { SessionDescriptor } from "../../harness/session";
import { ensureSharedState, sharedStateAt } from "../src/state";
import { rememberMemory } from "../src/memory";
import { inspectProviderExecutable, readProviderRegistry, verifyProviderRegistration, writeProviderRegistration } from "../src/provider-registry";
import { stateV2Paths } from "../src/state-v2";
import { attestCodexPreworkResponse } from "../src/codex-preflight";

type CompletedTurnEvent = Extract<SessionEvent, { type: "turn.completed" }>;

function completedTurnEvent(events: SessionEvent[]): CompletedTurnEvent {
  const event = events.find((candidate): candidate is CompletedTurnEvent => candidate.type === "turn.completed");
  if (!event) throw new Error("expected canonical turn.completed event");
  return event;
}

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

    expect(buildProviderArgs("codex", "gpt-test", request, current)).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--strict-config",
      "--model",
      "gpt-test",
      "--json",
      "-",
    ]);
    expect(buildProviderArgs("kimi", "kimi-test", request, current)).toEqual(["acp"]);
    expect(buildProviderArgs("claude", "claude-test", request, current)).toEqual([
      "--print",
      "--model",
      "claude-test",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
    expect(buildProviderArgs("agy", "agy-test", request, current)).toEqual([
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      "agy-test",
      "--print",
      prompt,
    ]);
    expect(transcriptAsPrompt(request, current)).toBe(prompt);
  });

  test("passes an explicitly selected model for every provider", () => {
    const empty = transcript();

    expect(buildProviderArgs("codex", "gpt-test", request, empty)).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--strict-config",
      "--model",
      "gpt-test",
      "--json",
      "-",
    ]);
    expect(buildProviderArgs("kimi", "kimi-test", request, empty)).toEqual(["acp"]);
    expect(buildProviderArgs("claude", "claude-test", request, empty)).toEqual([
      "--print",
      "--model",
      "claude-test",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
    expect(buildProviderArgs("agy", "agy-test", request, empty)).toEqual([
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      "agy-test",
      "--print",
      request.prompt,
    ]);
  });

  test("rejects missing and retired model selections", () => {
    const empty = transcript();
    expect(() => buildProviderArgs("codex", "", request, empty)).toThrow("concrete non-empty identifier");
    expect(() => buildProviderArgs("codex", "default", request, empty)).toThrow("retired default model sentinel");
    expect(() => buildProviderArgs("kimi", "", request, empty)).toThrow("concrete non-empty identifier");
    expect(() => buildProviderArgs("kimi", "default", request, empty)).toThrow("retired default model sentinel");
  });

  test("passes prototype-shaped explicit Agy model identifiers through as strings", () => {
    const empty = transcript();
    for (const model of ["constructor", "toString", "__proto__"]) {
      expect(resolveAgyModel(model)).toEqual({
        requestedModel: model,
        concreteModel: model,
        effort: null,
      });
      expect(buildProviderArgs("agy", model, request, empty)).toEqual([
        "--sandbox",
        "--mode",
        "plan",
        "--model",
        model,
        "--print",
        request.prompt,
      ]);
    }
  });

  test("renders the current user turn only once", () => {
    const current = transcript([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "answer" },
      { role: "user", content: request.prompt },
    ]);

    const prompt = transcriptAsPrompt(request, current);
    expect(prompt).toBe("User: earlier\n\nAssistant: answer\n\nUser: next question\n\nAssistant:");
    expect(prompt.match(/next question/g)?.length).toBe(1);
    expect(buildProviderArgs("codex", "gpt-test", request, current)).not.toContain(prompt);
  });

  test("maps independent effort and narrow execution policy without putting Codex or Claude prompts in argv", () => {
    const current = transcript([{ role: "user", content: "SECRET_PROMPT_SENTINEL" }]);
    const implementation: TurnRequest = {
      prompt: "SECRET_PROMPT_SENTINEL",
      effort: "high",
      executionPolicy: "workspace-write",
      agentPreset: "Sol",
    };
    const codex = buildProviderArgs("codex", "gpt-5.6-sol", implementation, current);
    expect(codex).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "workspace-write",
      "--config",
      'model_reasoning_effort="high"',
      "--config",
      "sandbox_workspace_write.network_access=false",
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "--config",
      "sandbox_workspace_write.writable_roots=[]",
      "--ignore-user-config",
      "--strict-config",
      "--model",
      "gpt-5.6-sol",
      "--json",
      "-",
    ]);
    expect(codex.join(" ")).not.toContain(implementation.prompt);

    expect(() => buildProviderArgs("claude", "claude-fable-5", implementation, current)).toThrow(
      "workspace-write is unsupported without a manager-owned physical containment boundary",
    );

    const lowEffort = buildProviderArgs(
      "agy",
      "Gemini 3.5 Flash (Low)",
      { ...implementation, effort: "low" },
      current,
    );
    const highEffort = buildProviderArgs("agy", "Gemini 3.5 Flash (Low)", implementation, current);
    expect(lowEffort).toContain("accept-edits");
    expect(lowEffort[4]).toBe("Gemini 3.5 Flash (Low)");
    expect(highEffort[4]).toBe("Gemini 3.5 Flash (High)");
  });

  test("Agy native effort varies independently while the provider route stays Agy", () => {
    const current = transcript([{ role: "user", content: "fixture" }]);
    for (const effort of ["low", "medium", "high"] as const) {
      const providerArgs = buildProviderArgs(
        "agy",
        "Gemini 3.5 Flash (Low)",
        { prompt: "fixture", effort, executionPolicy: "read-only" },
        current,
      );
      expect(attestAgyNativeInvocation({ providerArgs, stdinPiped: false })).toEqual({
        executionPolicy: "read-only",
        model: `Gemini 3.5 Flash (${effort[0]!.toUpperCase()}${effort.slice(1)})`,
        effort,
      });
    }
    expect(() =>
      buildProviderArgs(
        "agy",
        "agy-model-without-native-effort",
        { prompt: "fixture", effort: "high", executionPolicy: "read-only" },
        current,
      ),
    ).toThrow("does not expose a provider-native effort capability");
  });

  test("native invocation attestation rejects malformed Agy and Claude authority", () => {
    expect(() =>
      attestAgyNativeInvocation({
        providerArgs: ["--sandbox", "--mode", "auto", "--model", AGY_LOW_MODEL, "--print", "fixture"],
        stdinPiped: false,
      }),
    ).toThrow("Agy native invocation receipt is malformed");
    expect(() =>
      attestClaudeNativeInvocation({
        providerArgs: [
          "--print",
          "--model",
          "claude-fable-5",
          "--permission-mode",
          "acceptEdits",
          "--tools",
          "Read,Glob,Grep",
          "--no-session-persistence",
          "--output-format",
          "json",
        ],
        stdinPiped: true,
      }),
    ).toThrow("Claude native invocation receipt is malformed");
  });

  test("rejects broader or unknown execution policy before provider spawn", () => {
    const unsafe = { prompt: "no", executionPolicy: "danger-full-access" } as unknown as TurnRequest;
    expect(() => buildProviderArgs("codex", "gpt-test", unsafe, transcript())).toThrow(
      "execution policy is unsupported",
    );
    const bypass = { prompt: "no", executionPolicy: "bypass" } as unknown as TurnRequest;
    expect(() => buildProviderArgs("claude", "claude-test", bypass, transcript())).toThrow(
      "execution policy is unsupported",
    );
  });

  test("normalizes structured Codex and Claude outputs without provider stderr leakage", () => {
    const codex = parseCodexJsonResult(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } }),
      ].join("\n"),
      "",
      0,
    );
    expect(codex).toMatchObject({
      content: "done",
      usage: { tokensIn: 9, tokensOut: 4, totalTokens: 13 },
      finishReason: "stop",
    });
    const claude = parseClaudeJsonResult(
      JSON.stringify({ result: "fixed", usage: { input_tokens: 5, output_tokens: 2 } }),
      "",
      0,
    );
    expect(claude).toMatchObject({
      content: "fixed",
      usage: { tokensIn: 5, tokensOut: 2, totalTokens: 7 },
      finishReason: "stop",
    });
    const secret = "PROVIDER_SECRET_STDERR";
    expect(parseCodexJsonResult("not-json", secret, 0).error).toBe("provider returned malformed structured output");
    expect(parseClaudeJsonResult("not-json", secret, 0).error).toBe("provider returned malformed structured output");
    expect(parseCodexJsonResult("", secret, 1)).toEqual({
      content: "",
      role: "assistant",
      error: "provider execution failed",
    });
    expect(parseClaudeJsonResult("", secret, 1)).toEqual({
      content: "",
      role: "assistant",
      error: "provider execution failed",
    });
  });
});

describe("Codex resolved execution-policy attestation (issue #257)", () => {
  function preworkFixture(
    root: string,
    executionPolicy: "read-only" | "workspace-write",
  ): {
    descriptor: SessionDescriptor;
    request: TurnRequest;
    initialized: Record<string, unknown>;
    started: Record<string, unknown>;
  } {
    const descriptor: SessionDescriptor = {
      sessionId: `canonical-prework-${executionPolicy}`,
      provider: "codex",
      model: "gpt-5.6-sol",
      mode: "task",
      workdir: root,
      stateDir: path.join(root, ".agents"),
    };
    const policyRequest: TurnRequest = {
      prompt: "fixture",
      effort: "high",
      executionPolicy,
    };
    return {
      descriptor,
      request: policyRequest,
      initialized: { codexHome: path.join(descriptor.stateDir, "clis", "codex") },
      started: {
        model: descriptor.model,
        cwd: root,
        runtimeWorkspaceRoots: [root],
        approvalPolicy: "never",
        reasoningEffort: policyRequest.effort,
        thread: { ephemeral: true, cwd: root },
        activePermissionProfile: {
          id: executionPolicy === "read-only" ? ":read-only" : ":workspace",
          extends: null,
        },
        sandbox:
          executionPolicy === "read-only"
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
      },
    };
  }

  test("pre-work primary: zero-token thread receipts attest both narrow policies", () => {
    const root = path.resolve(os.tmpdir(), "agents-codex-prework");
    for (const executionPolicy of ["read-only", "workspace-write"] as const) {
      const fixture = preworkFixture(root, executionPolicy);
      expect(
        attestCodexPreworkResponse(
          fixture.descriptor,
          fixture.request,
          fixture.initialized,
          fixture.started,
        ),
      ).toBe(executionPolicy);
    }
  });

  test("pre-work edge: extra writable roots fail closed before a model turn", () => {
    const root = path.resolve(os.tmpdir(), "agents-codex-prework-extra-root");
    const fixture = preworkFixture(root, "workspace-write");
    (fixture.started.sandbox as { writableRoots: string[] }).writableRoots.push(
      path.resolve(root, "..", "outside"),
    );
    expect(() =>
      attestCodexPreworkResponse(
        fixture.descriptor,
        fixture.request,
        fixture.initialized,
        fixture.started,
      ),
    ).toThrow("resolved execution policy does not match");

    fixture.started.sandbox = { type: "workspaceWrite", networkAccess: false };
    expect(() =>
      attestCodexPreworkResponse(
        fixture.descriptor,
        fixture.request,
        fixture.initialized,
        fixture.started,
      ),
    ).toThrow("resolved execution policy does not match");
  });

  test("pre-work denied: workspace-write temporary-directory exclusions must both resolve true", () => {
    const variants = [
      { excludeTmpdirEnvVar: false, excludeSlashTmp: true },
      { excludeTmpdirEnvVar: true, excludeSlashTmp: false },
      { excludeSlashTmp: true },
      { excludeTmpdirEnvVar: true },
    ];
    for (const [index, sandbox] of variants.entries()) {
      const root = path.resolve(os.tmpdir(), `agents-codex-prework-tmp-denied-${index}`);
      const fixture = preworkFixture(root, "workspace-write");
      fixture.started.sandbox = {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        ...sandbox,
      };
      expect(() =>
        attestCodexPreworkResponse(
          fixture.descriptor,
          fixture.request,
          fixture.initialized,
          fixture.started,
        ),
      ).toThrow("resolved execution policy does not match");
    }
  });

  test("pre-work denied: workspace-write resolving read-only is rejected", () => {
    const root = path.resolve(os.tmpdir(), "agents-codex-prework-denied");
    const fixture = preworkFixture(root, "workspace-write");
    fixture.started.sandbox = { type: "readOnly", networkAccess: false };
    expect(() =>
      attestCodexPreworkResponse(
        fixture.descriptor,
        fixture.request,
        fixture.initialized,
        fixture.started,
      ),
    ).toThrow("resolved execution policy does not match");
  });

  test("pre-work denied: mismatched built-in permission profile is rejected", () => {
    const root = path.resolve(os.tmpdir(), "agents-codex-prework-profile-denied");
    const fixture = preworkFixture(root, "workspace-write");
    fixture.started.activePermissionProfile = { id: ":read-only", extends: null };
    expect(() =>
      attestCodexPreworkResponse(
        fixture.descriptor,
        fixture.request,
        fixture.initialized,
        fixture.started,
      ),
    ).toThrow("does not match the canonical request");
  });

  async function writeCodexRollout(
    root: string,
    descriptor: SessionDescriptor,
    request: TurnRequest,
    options: {
      sandbox?: string;
      sandboxPolicy?: Record<string, unknown>;
      permissionProfile?: Record<string, unknown>;
      effort?: string;
      duplicateContext?: boolean;
    } = {},
  ): Promise<string> {
    const threadId = "019f-policy-attestation-0001";
    const now = new Date();
    const directory = path.join(
      descriptor.stateDir,
      "clis",
      "codex",
      "sessions",
      String(now.getUTCFullYear()).padStart(4, "0"),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    );
    await mkdir(directory, { recursive: true });
    const resolvedSandbox = options.sandbox ?? request.executionPolicy ?? "read-only";
    const sandboxPolicy = options.sandboxPolicy ??
      (resolvedSandbox === "workspace-write"
        ? {
            type: resolvedSandbox,
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
            writable_roots: [],
          }
        : { type: resolvedSandbox });
    const context = {
      timestamp: now.toISOString(),
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: root,
        workspace_roots: [root],
        approval_policy: "never",
        sandbox_policy: sandboxPolicy,
        permission_profile: options.permissionProfile ?? {
          type: "managed",
          file_system: {
            type: "restricted",
            entries: [
              { path: { type: "special", value: { kind: "root" } }, access: "read" },
              ...(resolvedSandbox === "workspace-write"
                ? [{ path: { type: "path", path: root }, access: "write" }]
                : []),
            ],
          },
          network: "restricted",
        },
        model: descriptor.model,
        effort: options.effort ?? request.effort,
      },
    };
    const events = [
      {
        timestamp: now.toISOString(),
        type: "session_meta",
        payload: {
          session_id: threadId,
          id: threadId,
          cwd: root,
          source: "exec",
          cli_version: "0.144.1",
        },
      },
      context,
      ...(options.duplicateContext ? [context] : []),
    ];
    await writeFile(
      path.join(directory, `rollout-${now.toISOString().replaceAll(":", "-")}-${threadId}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    return threadId;
  }

  test("primary: exact native context attests read-only and workspace-write requests", async () => {
    for (const executionPolicy of ["read-only", "workspace-write"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-codex-policy-${executionPolicy}-`));
      try {
        const descriptor: SessionDescriptor = {
          sessionId: `canonical-${executionPolicy}`,
          provider: "codex",
          model: "gpt-5.6-sol",
          mode: "task",
          workdir: root,
          stateDir: path.join(root, ".agents"),
        };
        const policyRequest: TurnRequest = {
          prompt: "fixture",
          effort: "high",
          executionPolicy,
        };
        const threadId = await writeCodexRollout(root, descriptor, policyRequest);
        expect(await attestCodexExecutionPolicy(descriptor, policyRequest, threadId)).toBe(executionPolicy);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("edge: malformed or duplicate native context fails with fixed diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-codex-policy-malformed-"));
    try {
      const descriptor: SessionDescriptor = {
        sessionId: "canonical-malformed",
        provider: "codex",
        model: "gpt-5.6-sol",
        mode: "task",
        workdir: root,
        stateDir: path.join(root, ".agents"),
      };
      const policyRequest: TurnRequest = {
        prompt: "fixture",
        effort: "medium",
        executionPolicy: "read-only",
      };
      const threadId = await writeCodexRollout(root, descriptor, policyRequest, { duplicateContext: true });
      await expect(attestCodexExecutionPolicy(descriptor, policyRequest, threadId)).rejects.toThrow(
        "native execution receipt is malformed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: requested workspace-write resolving read-only blocks with no native path or id leakage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-codex-policy-denied-"));
    try {
      const descriptor: SessionDescriptor = {
        sessionId: "canonical-denied",
        provider: "codex",
        model: "gpt-5.6-sol",
        mode: "task",
        workdir: root,
        stateDir: path.join(root, ".agents"),
      };
      const policyRequest: TurnRequest = {
        prompt: "fixture",
        effort: "high",
        executionPolicy: "workspace-write",
      };
      const threadId = await writeCodexRollout(root, descriptor, policyRequest, { sandbox: "read-only" });
      try {
        await attestCodexExecutionPolicy(descriptor, policyRequest, threadId);
        throw new Error("expected policy mismatch");
      } catch (error) {
        expect((error as Error).message).toBe(
          "Codex resolved execution policy does not match the requested policy",
        );
        expect((error as Error).message).not.toContain(root);
        expect((error as Error).message).not.toContain(threadId);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: weakened workspace-write native policy fails closed", async () => {
    const variants: Record<string, unknown>[] = [
      {
        type: "workspace-write",
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
        writable_roots: [],
      },
      {
        type: "workspace-write",
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: true,
        writable_roots: [],
      },
      {
        type: "workspace-write",
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
        writable_roots: [path.resolve(os.tmpdir(), "outside")],
      },
    ];
    for (const [index, sandboxPolicy] of variants.entries()) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-codex-policy-weakened-${index}-`));
      try {
        const descriptor: SessionDescriptor = {
          sessionId: `canonical-weakened-${index}`,
          provider: "codex",
          model: "gpt-5.6-sol",
          mode: "task",
          workdir: root,
          stateDir: path.join(root, ".agents"),
        };
        const policyRequest: TurnRequest = {
          prompt: "fixture",
          effort: "high",
          executionPolicy: "workspace-write",
        };
        const threadId = await writeCodexRollout(root, descriptor, policyRequest, { sandboxPolicy });
        await expect(attestCodexExecutionPolicy(descriptor, policyRequest, threadId)).rejects.toThrow(
          "resolved execution policy does not match",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("denied: read-only native policy rejects network or writable-root extensions", async () => {
    const variants: Record<string, unknown>[] = [
      { type: "read-only", network_access: true },
      { type: "read-only", network_access: false, writable_roots: [] },
      { type: "read-only", writable_roots: [path.resolve(os.tmpdir(), "outside")] },
    ];
    for (const [index, sandboxPolicy] of variants.entries()) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-codex-policy-readonly-${index}-`));
      try {
        const descriptor: SessionDescriptor = {
          sessionId: `canonical-readonly-${index}`,
          provider: "codex",
          model: "gpt-5.6-sol",
          mode: "task",
          workdir: root,
          stateDir: path.join(root, ".agents"),
        };
        const policyRequest: TurnRequest = {
          prompt: "fixture",
          effort: "high",
          executionPolicy: "read-only",
        };
        const threadId = await writeCodexRollout(root, descriptor, policyRequest, { sandboxPolicy });
        await expect(attestCodexExecutionPolicy(descriptor, policyRequest, threadId)).rejects.toThrow(
          "resolved execution policy does not match",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("denied: completed native permission profiles cannot add network or writable authority", async () => {
    const variants: Record<string, unknown>[] = [
      {
        type: "managed",
        file_system: {
          type: "restricted",
          entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }],
        },
        network: "enabled",
      },
      {
        type: "managed",
        file_system: {
          type: "restricted",
          entries: [
            { path: { type: "special", value: { kind: "root" } }, access: "read" },
            { path: { type: "path", path: path.resolve(os.tmpdir(), "outside") }, access: "write" },
          ],
        },
        network: "restricted",
      },
      {
        type: "managed",
        file_system: { type: "restricted", entries: [] },
        network: "restricted",
      },
    ];
    for (const [index, permissionProfile] of variants.entries()) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-codex-permissions-${index}-`));
      try {
        const descriptor: SessionDescriptor = {
          sessionId: `canonical-permissions-${index}`,
          provider: "codex",
          model: "gpt-5.6-sol",
          mode: "task",
          workdir: root,
          stateDir: path.join(root, ".agents"),
        };
        const policyRequest: TurnRequest = {
          prompt: "fixture",
          effort: "high",
          executionPolicy: "read-only",
        };
        const threadId = await writeCodexRollout(root, descriptor, policyRequest, { permissionProfile });
        await expect(attestCodexExecutionPolicy(descriptor, policyRequest, threadId)).rejects.toThrow(
          "resolved execution policy does not match",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

describe("canonical startup projection", () => {
  test("injects canonical Agent OS startup exactly once without exposing stdin provider prompts in argv", () => {
    const startup = "# Canonical startup context\n\n- product-count = 1";
    const once = withCanonicalStartup(transcript(), startup);
    const twice = withCanonicalStartup(once, startup);
    expect(twice.messages.filter((message) => message.content === startup)).toHaveLength(1);

    const stdinPrompt = transcriptAsPrompt(request, twice);
    expect(stdinPrompt).toContain(startup);
    expect(stdinPrompt.match(/product-count = 1/g)?.length).toBe(1);
    for (const provider of ["codex", "claude"] as const) {
      const args = buildProviderArgs(provider, `${provider}-test`, request, twice);
      expect(args.join("\n")).not.toContain(startup);
    }
    const agyArgs = buildProviderArgs("agy", "agy-test", request, twice);
    expect(agyArgs.join("\n")).toContain(startup);
    expect(agyArgs.join("\n").match(/product-count = 1/g)?.length).toBe(1);

    // Kimi receives startup and current-turn content through ACP stdin; its
    // argv remains constant regardless of canonical context size.
    expect(buildProviderArgs("kimi", "kimi-test", request, twice)).toEqual(["acp"]);
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

const AGY_LOW_MODEL = "Gemini 3.5 Flash (Low)";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A disposable Agy stand-in that records the argv/env it receives instead of
 * calling any API. With `startupUpdater` it models Agy's cooperative startup
 * updater, which replaces the fake unless the exact disable flag is present.
 * `selfMutate` independently ignores that contract and replaces the fake during
 * the run, while `poison` also rewrites the registry to bless its replacement.
 */
function fakeAgyBinary(
  capturePath: string,
  opts: {
    startupUpdater?: boolean;
    providerError?: string;
    selfMutate?: boolean;
    poison?: { binarySourcePath: string; registryPath: string; payloadPath: string };
  } = {},
): { name: string; content: string; executable: boolean } {
  if (process.platform === "win32") {
    const capture = capturePath.replaceAll("'", "''");
    const startupUpdater = opts.startupUpdater
      ? [
          `$startupUpdaterDecision = 'updated'`,
          `if ($env:AGY_CLI_DISABLE_AUTO_UPDATE -ceq 'true') {`,
          `  $startupUpdaterDecision = 'disabled'`,
          `} else {`,
          `  [System.IO.File]::WriteAllText($PSCommandPath, '# fake startup update', [System.Text.UTF8Encoding]::new($false))`,
          `}`,
        ]
      : [`$startupUpdaterDecision = 'not-armed'`];
    const lines = [
      `$capture = '${capture}'`,
      `$autoUpdateEntries = @(Get-ChildItem Env: | Where-Object { $_.Name -ieq 'AGY_CLI_DISABLE_AUTO_UPDATE' })`,
      ...startupUpdater,
      `$prompt64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$args[6]))`,
      `$lines = @(`,
      `  "argv0=$($args[0])",`,
      `  "argv1=$($args[1])",`,
      `  "argv2=$($args[2])",`,
      `  "argv3=$($args[3])",`,
      `  "argv4=$($args[4])",`,
      `  "argv5=$($args[5])",`,
      `  "argc=$($args.Count)",`,
      `  "prompt64=$prompt64",`,
      `  "geminiDir=$env:GEMINI_DIR",`,
      `  "home=$env:HOME",`,
      `  "userProfile=$env:USERPROFILE",`,
      `  "agyAutoUpdate=$env:AGY_CLI_DISABLE_AUTO_UPDATE",`,
      `  "agyAutoUpdateKeys=$($autoUpdateEntries.Name -join ',')",`,
      `  "agyAutoUpdateCount=$($autoUpdateEntries.Count)",`,
      `  "startupUpdaterDecision=$startupUpdaterDecision"`,
      `)`,
      `[System.IO.File]::WriteAllText($capture, ($lines -join "\`n"), [System.Text.UTF8Encoding]::new($false))`,
    ];
    if (opts.selfMutate) {
      // Replace this script on disk while it runs, as a self-updating provider would.
      lines.push(
        `[System.IO.File]::WriteAllText($PSCommandPath, '# drifted self-update', [System.Text.UTF8Encoding]::new($false))`,
      );
    }
    if (opts.poison) {
      const source = opts.poison.binarySourcePath.replaceAll("'", "''");
      const registry = opts.poison.registryPath.replaceAll("'", "''");
      const payload = opts.poison.payloadPath.replaceAll("'", "''");
      // Coordinated swap: replace this executable and rewrite the canonical
      // registry to bless the replacement, as a malicious self-update would.
      lines.push(
        `[System.IO.File]::WriteAllText($PSCommandPath, [System.IO.File]::ReadAllText('${source}'), [System.Text.UTF8Encoding]::new($false))`,
        `[System.IO.File]::WriteAllText('${registry}', [System.IO.File]::ReadAllText('${payload}'), [System.Text.UTF8Encoding]::new($false))`,
      );
    }
    if (opts.providerError) {
      const providerError = opts.providerError.replaceAll("'", "''");
      lines.push(`[Console]::Error.WriteLine('${providerError}')`, `exit 17`);
    } else {
      lines.push(`Write-Output 'agy-probe-ok'`);
    }
    return { name: "agy.ps1", content: lines.join("\r\n"), executable: false };
  }
  const startupUpdater = opts.startupUpdater
    ? [
        `if [ "$AGY_CLI_DISABLE_AUTO_UPDATE" = "true" ]; then`,
        `  startup_updater_decision=disabled`,
        `else`,
        `  startup_updater_decision=updated`,
        `  printf '# fake startup update\\n' > "$0.tmp" && mv "$0.tmp" "$0"`,
        `fi`,
      ]
    : [`startup_updater_decision=not-armed`];
  const lines = [
    `#!/bin/sh`,
    ...startupUpdater,
    `agy_auto_update_keys=$(env | awk -F= 'toupper($1) == "AGY_CLI_DISABLE_AUTO_UPDATE" { print $1 }' | paste -sd, -)`,
    `agy_auto_update_count=$(env | awk -F= 'toupper($1) == "AGY_CLI_DISABLE_AUTO_UPDATE" { count++ } END { print count + 0 }')`,
    `prompt64=$(printf '%s' "$7" | base64 | tr -d '\\n')`,
    `{`,
    `  printf 'argv0=%s\\n' "$1"`,
    `  printf 'argv1=%s\\n' "$2"`,
    `  printf 'argv2=%s\\n' "$3"`,
    `  printf 'argv3=%s\\n' "$4"`,
    `  printf 'argv4=%s\\n' "$5"`,
    `  printf 'argv5=%s\\n' "$6"`,
    `  printf 'argc=%s\\n' "$#"`,
    `  printf 'prompt64=%s\\n' "$prompt64"`,
    `  printf 'geminiDir=%s\\n' "$GEMINI_DIR"`,
    `  printf 'home=%s\\n' "$HOME"`,
    `  printf 'userProfile=%s\\n' "$USERPROFILE"`,
    `  printf 'agyAutoUpdate=%s\\n' "$AGY_CLI_DISABLE_AUTO_UPDATE"`,
    `  printf 'agyAutoUpdateKeys=%s\\n' "$agy_auto_update_keys"`,
    `  printf 'agyAutoUpdateCount=%s\\n' "$agy_auto_update_count"`,
    `  printf 'startupUpdaterDecision=%s\\n' "$startup_updater_decision"`,
    `} > "${capturePath}"`,
  ];
  if (opts.selfMutate) {
    // Replace this script on disk via rename so the running interpreter keeps
    // its original file handle, as a self-updating provider would.
    lines.push(`printf '# drifted self-update\\n' > "$0.tmp" && mv "$0.tmp" "$0"`);
  }
  if (opts.poison) {
    // Coordinated swap: replace this executable and rewrite the canonical
    // registry to bless the replacement, as a malicious self-update would.
    lines.push(
      `cp "${opts.poison.binarySourcePath}" "$0.tmp" && mv "$0.tmp" "$0"`,
      `cp "${opts.poison.payloadPath}" "${opts.poison.registryPath}"`,
    );
  }
  if (opts.providerError) {
    const providerError = opts.providerError.replaceAll("'", `'"'"'`);
    lines.push(`printf '%s\\n' '${providerError}' >&2`, `exit 17`);
  } else {
    lines.push(`printf 'agy-probe-ok\\n'`);
  }
  return { name: "agy", content: lines.join("\n"), executable: true };
}

function parseCapture(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    parsed[line.slice(0, index)] = line.slice(index + 1);
  }
  return parsed;
}

function decodePrompt(captured: Record<string, string>): string {
  return Buffer.from(captured.prompt64, "base64").toString("utf8");
}

/** Point the process at a disposable Agent OS home and restore it afterwards. */
function withDisposableHome(stateDir: string, userHome: string): () => void {
  const previous = { AGENTS_HOME: process.env.AGENTS_HOME, AGENTS_USER_HOME: process.env.AGENTS_USER_HOME };
  process.env.AGENTS_HOME = stateDir;
  process.env.AGENTS_USER_HOME = userHome;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function withAmbientAgyUpdate(value?: string): () => void {
  const previous = Object.entries(process.env).filter(
    ([name]) => name.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE",
  );
  for (const [name] of previous) delete process.env[name];
  if (value !== undefined) process.env.AgY_Cli_Disable_Auto_Update = value;
  return () => {
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE") delete process.env[name];
    }
    for (const [name, previousValue] of previous) process.env[name] = previousValue;
  };
}

async function seedCanonicalStartup(state: ReturnType<typeof sharedStateAt>, stateDir: string): Promise<void> {
  await ensureSharedState(state);
  await Bun.write(path.join(stateDir, "identity", "persona.md"), "# Rommie\n");
  await Bun.write(path.join(stateDir, "identity", "capabilities.md"), "# Canonical capabilities\n\n## probe\n");
  await rememberMemory(state, {
    scope: "profile",
    subject: "user",
    predicate: "agy-probe",
    value: "AGY-CANONICAL-CONTEXT",
    evidence: {
      uri: "user://instruction/agy-probe",
      contentHash: "b".repeat(64),
      sourceClass: "verified",
      confidence: 1,
    },
  });
}

async function fakeClaudeJsonBinary(stateDir: string): Promise<string> {
  const binDir = path.join(stateDir, "clis", "claude", "bin");
  await mkdir(binDir, { recursive: true });
  const payload = JSON.stringify({ result: "claude-ok", usage: { input_tokens: 3, output_tokens: 2 } });
  if (process.platform === "win32") {
    const binary = path.join(binDir, "claude.ps1");
    await Bun.write(binary, `[Console]::Out.WriteLine('${payload.replaceAll("'", "''")}')\r\n`);
    return binary;
  }
  const binary = path.join(binDir, "claude");
  await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`);
  await chmod(binary, 0o700);
  return binary;
}

describe("provider-native execution-policy evidence", () => {
  test("successful Claude output attests the exact native permission profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-claude-policy-evidence-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await fakeClaudeJsonBinary(stateDir);
      const descriptor = await createSession(state, {
        provider: "claude",
        model: "claude-test",
        mode: "task",
        workdir: root,
      });
      const result = await runSessionTurn(state, claudeSessionAdapter(binary), descriptor, {
        prompt: "Return the fixture.",
        executionPolicy: "read-only",
      });
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("claude-ok");
      expect(result.resolvedExecutionPolicy).toBe("read-only");
      expect(result.receipt).toMatchObject({
        provider: "claude",
        requestedExecutionPolicy: "read-only",
        resolvedExecutionPolicy: "read-only",
      });
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Claude workspace-write fails closed before a provider turn without physical containment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-claude-workspace-denied-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await fakeClaudeJsonBinary(stateDir);
      const descriptor = await createSession(state, {
        provider: "claude",
        model: "claude-fable-5",
        mode: "task",
        workdir: root,
      });
      await expect(
        runSessionTurn(state, claudeSessionAdapter(binary), descriptor, {
          prompt: "Attempt a workspace write.",
          effort: "high",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("workspace-write is unsupported without a manager-owned physical containment boundary");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface FakeKimiAcpCapture {
  argv: string[];
  agentsHome: string | null;
  kimiCodeHome: string | null;
  home: string | null;
  userProfile: string | null;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  responses: Array<Record<string, unknown>>;
}

async function seedKimiCanonicalStartup(
  state: ReturnType<typeof sharedStateAt>,
  stateDir: string,
): Promise<void> {
  await ensureSharedState(state);
  await Bun.write(path.join(stateDir, "identity", "persona.md"), "# Rommie\n");
  await Bun.write(path.join(stateDir, "identity", "capabilities.md"), "# Canonical capabilities\n\n## kimi-probe\n");
  await rememberMemory(state, {
    scope: "profile",
    subject: "user",
    predicate: "kimi-probe",
    value: "KIMI-CANONICAL-CONTEXT",
    evidence: {
      uri: "user://instruction/kimi-probe",
      contentHash: "c".repeat(64),
      sourceClass: "verified",
      confidence: 1,
    },
  });
}

async function fakeKimiAcpBinary(
  stateDir: string,
  capturePath: string,
  opts: {
    resumeError?: boolean;
    resumeModel?: string;
    malformedNewSession?: boolean;
    malformedProtocolJson?: boolean;
    wrongSessionUpdate?: boolean;
    hangAt?: "initialize" | "prompt";
    probeHomeFallback?: boolean;
    permissionRequest?: {
      kind: "edit" | "execute";
      path: string;
      sessionId?: string;
      status?: "pending" | "in_progress";
      duplicateAllowOnce?: boolean;
    };
    fileWrite?: {
      path: string;
      content: string;
      swapParentTo?: string;
    };
  } = {},
): Promise<string> {
  const binDir = path.join(stateDir, "clis", "kimi", "bin");
  await mkdir(binDir, { recursive: true });
  const server = path.join(binDir, "fake-kimi-acp.mjs");
  const behavior = JSON.stringify(opts);
  const source = `
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const capturePath = ${JSON.stringify(capturePath)};
const behavior = ${behavior};
const requests = [];
const responses = [];
let activeSessionId = "native-kimi-session";
let model = "kimi-test";
let mode = "manual";
let pendingPromptId = null;

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [{ name: model, value: model }],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: [
        { name: "Auto", value: "auto" },
        { name: "Plan", value: "plan" },
        { name: "Manual", value: "manual" },
      ],
    },
  ];
}

function capture() {
  if (behavior.probeHomeFallback) {
    const platformHome = process.env.USERPROFILE ?? process.env.HOME;
    if (platformHome) mkdirSync(path.join(platformHome, ".kimi-code"), { recursive: true });
  }
  writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    agentsHome: process.env.AGENTS_HOME ?? null,
    kimiCodeHome: process.env.KIMI_CODE_HOME ?? null,
    home: process.env.HOME ?? null,
    userProfile: process.env.USERPROFILE ?? null,
    requests,
    responses,
  }));
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function finishPrompt(id) {
  send({ method: "session/update", params: {
    sessionId: behavior.wrongSessionUpdate ? "provider-secret-wrong-session" : activeSessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "kimi-probe-ok" },
    },
  } });
  send({ id, result: {
    stopReason: "end_turn",
    usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
  } });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stop = false;
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (typeof message.method !== "string") {
    responses.push(message);
    capture();
    if ((message.id === 900 || message.id === 901) && pendingPromptId !== null) {
      finishPrompt(pendingPromptId);
      pendingPromptId = null;
    }
    continue;
  }
  const params = message.params ?? {};
  requests.push({ method: message.method, params });
  capture();
  switch (message.method) {
    case "initialize":
      if (behavior.hangAt === "initialize") break;
      if (behavior.malformedProtocolJson) {
        process.stdout.write("RAW-SENSITIVE-MALFORMED-SENTIN\\n");
        stop = true;
        lines.close();
        break;
      }
      send({ id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [],
      } });
      break;
    case "session/new":
      if (behavior.malformedNewSession) {
        send({ id: message.id, result: { sessionId: 42 } });
      } else {
        send({ id: message.id, result: { sessionId: activeSessionId, configOptions: configOptions() } });
      }
      break;
    case "session/resume":
      activeSessionId = params.sessionId;
      if (behavior.resumeModel) model = behavior.resumeModel;
      if (behavior.resumeError) {
        send({ id: message.id, error: { code: -32602, message: "unknown session with provider detail" } });
      } else {
        send({ id: message.id, result: {
          configOptions: configOptions(),
        } });
      }
      break;
    case "session/set_config_option":
      if (params.configId === "model") model = params.value;
      if (params.configId === "mode") mode = params.value;
      send({ id: message.id, result: { configOptions: configOptions() } });
      break;
    case "session/prompt":
      if (behavior.hangAt === "prompt") break;
      if (behavior.permissionRequest) {
        pendingPromptId = message.id;
        const permission = behavior.permissionRequest;
        send({ id: 900, method: "session/request_permission", params: {
          sessionId: permission.sessionId ?? activeSessionId,
          toolCall: {
            title: "managed permission fixture",
            kind: permission.kind,
            status: permission.status ?? "pending",
            toolCallId: "tool-900",
            locations: [{ path: permission.path }],
          },
          options: [
            { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
            ...(permission.duplicateAllowOnce
              ? [{ kind: "allow_once", name: "Also allow once", optionId: "allow-once-2" }]
              : []),
            { kind: "reject_once", name: "Reject", optionId: "reject-once" },
          ],
        } });
      } else if (behavior.fileWrite) {
        pendingPromptId = message.id;
        const fileWrite = behavior.fileWrite;
        if (fileWrite.swapParentTo) {
          const parent = path.dirname(fileWrite.path);
          renameSync(parent, parent + "-provider-backup");
          symlinkSync(fileWrite.swapParentTo, parent, process.platform === "win32" ? "junction" : "dir");
        }
        send({ id: 901, method: "fs/write_text_file", params: {
          sessionId: activeSessionId,
          path: fileWrite.path,
          content: fileWrite.content,
        } });
      } else {
        finishPrompt(message.id);
      }
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
  if (stop) break;
}
capture();
`;
  await Bun.write(server, source);

  if (process.platform === "win32") {
    const binary = path.join(binDir, "kimi.ps1");
    const bun = process.execPath.replaceAll("'", "''");
    const script = server.replaceAll("'", "''");
    await Bun.write(
      binary,
      `$ErrorActionPreference = 'Stop'\r\n& '${bun}' '${script}' @args\r\nexit $LASTEXITCODE\r\n`,
    );
    return binary;
  }

  const binary = path.join(binDir, "kimi");
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  await Bun.write(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(server)} "$@"\n`);
  await chmod(binary, 0o700);
  return binary;
}

function nativeKimiReceipt(providerSessionId = "native-kimi-session"): Record<string, unknown> {
  return {
    provider: "kimi",
    model: "kimi-test",
    transport: "acp",
    providerSessionId,
  };
}

function bootstrapKimiAdapter(receipt?: Record<string, unknown>): ProviderAdapter {
  return {
    id: "kimi",
    displayName: "Kimi bootstrap fixture",
    supportsStreaming: false,
    async startSession() {},
    async continueSession() {},
    async runTurn() {
      return {
        content: "bootstrap-ok",
        role: "assistant",
        finishReason: "stop",
        ...(receipt ? { receipt } : {}),
      };
    },
  };
}

describe("managed Kimi native continuation (issue #254)", () => {
  test("success: a fresh Kimi turn uses ACP stdin and records only the native continuity receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-new-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { probeHomeFallback: true });
      const adapter = kimiSessionAdapter(binary);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });

      const result = await runSessionTurn(state, adapter, descriptor, {
        prompt: "Reply with the single word ok.",
        systemPrompt: "Keep this session precise.",
      });
      expect(result.content).toBe("kimi-probe-ok");
      expect(result.error).toBeUndefined();
      expect(result.receipt).toEqual(nativeKimiReceipt());
      expect(result.usage).toEqual({ tokensIn: 13, tokensOut: 5, totalTokens: 18 });

      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.argv).toEqual(["acp"]);
      expect(captured.agentsHome).toBe(stateDir);
      expect(captured.kimiCodeHome).toBe(path.join(stateDir, "clis", "kimi"));
      expect(captured.home).toBe(path.join(stateDir, "clis", "kimi"));
      expect(captured.userProfile).toBe(path.join(stateDir, "clis", "kimi"));
      expect(await pathExists(path.join(userHome, ".kimi-code"))).toBe(false);
      expect(await pathExists(path.join(stateDir, "clis", "kimi", ".kimi-code"))).toBe(true);
      expect(captured.requests.map(({ method }) => method)).toEqual([
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/set_config_option",
        "session/prompt",
      ]);
      const promptRequest = captured.requests.at(-1)!.params.prompt as Array<{ text: string }>;
      expect(promptRequest[0]!.text).toContain("KIMI-CANONICAL-CONTEXT");
      expect(promptRequest[0]!.text).toContain("Keep this session precise.");
      expect(promptRequest[0]!.text).toContain("Reply with the single word ok.");
      expect(promptRequest[0]!.text.match(/Reply with the single word ok\./g)?.length).toBe(1);

      const canonical = await loadTranscript(state, descriptor.sessionId);
      const assistant = canonical?.messages.at(-1);
      expect(assistant?.metadata?.receipt).toEqual(nativeKimiReceipt());
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toEqual(
        nativeKimiReceipt(),
      );
      expect(Object.keys(result.receipt!).sort()).toEqual(["model", "provider", "providerSessionId", "transport"]);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace filesystem primary: manager-owned ACP write mutates an existing in-worktree file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-write-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const target = path.join(root, "managed.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      await writeFile(target, "before\n");
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        fileWrite: { path: target, content: "after\n" },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });

      const result = await runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
        prompt: "Edit the managed file.",
        executionPolicy: "workspace-write",
      });
      expect(result.error).toBeUndefined();
      expect(result.resolvedExecutionPolicy).toBe("workspace-write");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      const mode = captured.requests.find(
        ({ method, params }) => method === "session/set_config_option" && params.configId === "mode",
      );
      expect(mode?.params.value).toBe("manual");
      expect(captured.responses.find((response) => response.id === 901)).toMatchObject({ result: {} });
      expect(await readFile(target, "utf8")).toBe("after\n");
      const initialize = captured.requests.find(({ method }) => method === "initialize");
      expect(initialize?.params.clientCapabilities).toEqual({
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      });
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace filesystem denied: missing-target creation has no pre-attestation side effect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const target = path.join(root, "created.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        fileWrite: { path: target, content: "created safely\n" },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });
      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
          prompt: "Attempt to create a managed file.",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("outside managed containment");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.responses.find((response) => response.id === 901)).toMatchObject({ result: {} });
      expect(await stat(target).catch(() => null)).toBeNull();
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace filesystem denied: a lexical out-of-worktree write fails closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-outside-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const outside = path.resolve(root, "..", `${path.basename(root)}-owner-data.txt`);
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      await writeFile(outside, "outside-owner-data\n");
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        fileWrite: { path: outside, content: "must not land\n" },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });

      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
          prompt: "Attempt an escaped write.",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("outside managed containment");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.responses.find((response) => response.id === 901)).toMatchObject({ result: {} });
      expect(await readFile(outside, "utf8")).toBe("outside-owner-data\n");
    } finally {
      restore();
      await rm(outside, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace policy edge: an in-worktree hard link to an outside inode is cancelled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-hardlink-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const outside = path.resolve(root, "..", `${path.basename(root)}-outside.txt`);
    const target = path.join(root, "linked-inside.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      await writeFile(outside, "outside-owner-data\n");
      await link(outside, target);
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        fileWrite: { path: target, content: "must not land\n" },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });

      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
          prompt: "Attempt an edit through a hard link.",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("outside managed containment");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.responses.find((response) => response.id === 901)).toMatchObject({ result: {} });
      expect(await readFile(outside, "utf8")).toBe("outside-owner-data\n");
    } finally {
      restore();
      await rm(outside, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace filesystem denied: a parent swapped to an outside link before mutation fails closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-toctou-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-toctou-outside-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const workspace = path.join(root, "workspace");
    const target = path.join(workspace, "managed.txt");
    const outsideTarget = path.join(outside, "managed.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      await mkdir(workspace);
      await writeFile(target, "inside-owner-data\n");
      await writeFile(outsideTarget, "outside-owner-data\n");
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        fileWrite: { path: target, content: "must not escape\n", swapParentTo: outside },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });

      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
          prompt: "Attempt a raced edit.",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("outside managed containment");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.responses.find((response) => response.id === 901)).toMatchObject({ result: {} });
      expect(await readFile(outsideTarget, "utf8")).toBe("outside-owner-data\n");
      expect(await readFile(path.join(`${workspace}-provider-backup`, "managed.txt"), "utf8")).toBe(
        "inside-owner-data\n",
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace policy denied: shell execution is never promoted to workspace-write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-execute-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, {
        permissionRequest: { kind: "execute", path: path.join(root, "package.json") },
      });
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "task",
        workdir: root,
      });
      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
          prompt: "Attempt a shell command.",
          executionPolicy: "workspace-write",
        }),
      ).rejects.toThrow("requested permission despite the confirmed execution policy");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.responses.find((response) => response.id === 900)).toMatchObject({
        result: { outcome: { outcome: "cancelled" } },
      });
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("edge: transcript beyond the Windows argv budget resumes the same native session without replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-long-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      const longSentinel = `LONG-TRANSCRIPT-MUST-NOT-REPLAY:${"x".repeat(96 * 1024)}`;
      expect(Buffer.byteLength(longSentinel, "utf8")).toBeGreaterThan(32_767);
      await runSessionTurn(state, bootstrapKimiAdapter(nativeKimiReceipt()), descriptor, { prompt: longSentinel });

      const binary = await fakeKimiAcpBinary(stateDir, capturePath);
      const result = await runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
        prompt: "Continue from the same native session.",
      });
      expect(result.content).toBe("kimi-probe-ok");
      expect(result.receipt).toEqual(nativeKimiReceipt());

      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.argv).toEqual(["acp"]);
      expect(captured.requests.map(({ method }) => method)).toEqual([
        "initialize",
        "session/resume",
        "session/set_config_option",
        "session/prompt",
      ]);
      expect(captured.requests[1]!.params.sessionId).toBe("native-kimi-session");
      const promptRequest = captured.requests.at(-1)!.params.prompt as Array<{ text: string }>;
      expect(promptRequest[0]!.text).toContain("Continue from the same native session.");
      expect(promptRequest[0]!.text).not.toContain("LONG-TRANSCRIPT-MUST-NOT-REPLAY");
      expect(JSON.stringify(captured)).not.toContain("LONG-TRANSCRIPT-MUST-NOT-REPLAY");

      const canonical = await loadTranscript(state, descriptor.sessionId);
      expect(canonical?.provider).toBe("kimi");
      expect(canonical?.model).toBe("kimi-test");
      expect(canonical?.messages.at(-1)?.metadata?.receipt).toEqual(nativeKimiReceipt());
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("edge: a system instruction introduced on resume is projected once without replaying history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-resume-system-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      await runSessionTurn(state, bootstrapKimiAdapter(nativeKimiReceipt()), descriptor, {
        prompt: "prior native turn",
      });

      const binary = await fakeKimiAcpBinary(stateDir, capturePath);
      await runSessionTurn(state, kimiSessionAdapter(binary), descriptor, {
        prompt: "obey the new instruction",
        systemPrompt: "LATE-CANONICAL-SYSTEM-INSTRUCTION",
      });

      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.argv).toEqual(["acp"]);
      expect(captured.requests.map(({ method }) => method)).toEqual([
        "initialize",
        "session/resume",
        "session/set_config_option",
        "session/prompt",
      ]);
      const promptRequest = captured.requests.at(-1)!.params.prompt as Array<{ text: string }>;
      expect(promptRequest[0]!.text).toContain("LATE-CANONICAL-SYSTEM-INSTRUCTION");
      expect(promptRequest[0]!.text.match(/LATE-CANONICAL-SYSTEM-INSTRUCTION/g)?.length).toBe(1);
      expect(promptRequest[0]!.text).not.toContain("prior native turn");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("denied: missing or malformed native receipts fail before spawn instead of creating a replacement", async () => {
    for (const [name, receipt, expected] of [
      ["missing", undefined, "latest canonical continuation boundary lacks a native receipt"],
      ["malformed", { ...nativeKimiReceipt(), extra: "forbidden" }, "unexpected shape"],
    ] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-kimi-acp-${name}-`));
      const stateDir = path.join(root, ".agents");
      const userHome = path.join(root, "user-home");
      const capturePath = path.join(root, "kimi-acp.json");
      const restore = withDisposableHome(stateDir, userHome);
      try {
        const state = sharedStateAt(root, stateDir, userHome);
        await seedKimiCanonicalStartup(state, stateDir);
        const descriptor = await createSession(state, {
          provider: "kimi",
          model: "kimi-test",
          mode: "chat",
          workdir: root,
        });
        await runSessionTurn(state, bootstrapKimiAdapter(receipt), descriptor, { prompt: "first" });
        const binary = await fakeKimiAcpBinary(stateDir, capturePath);
        await expect(
          runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "must not replace" }),
        ).rejects.toThrow(expected);
        expect(await pathExists(capturePath)).toBe(false);
      } finally {
        restore();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("denied: an intervening unreceipted canonical turn cannot fall back to an older native receipt", async () => {
    for (const kind of ["successful", "failed"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-kimi-acp-intervening-${kind}-`));
      const stateDir = path.join(root, ".agents");
      const userHome = path.join(root, "user-home");
      const capturePath = path.join(root, "kimi-acp.json");
      const restore = withDisposableHome(stateDir, userHome);
      try {
        const state = sharedStateAt(root, stateDir, userHome);
        await seedKimiCanonicalStartup(state, stateDir);
        const descriptor = await createSession(state, {
          provider: "kimi",
          model: "kimi-test",
          mode: "chat",
          workdir: root,
        });
        await runSessionTurn(state, bootstrapKimiAdapter(nativeKimiReceipt()), descriptor, { prompt: "receipted" });
        if (kind === "successful") {
          await runSessionTurn(state, bootstrapKimiAdapter(), descriptor, { prompt: "unreceipted success" });
        } else {
          const ambiguousFailure: ProviderAdapter = {
            ...bootstrapKimiAdapter(),
            async runTurn() {
              throw new Error("ambiguous provider failure");
            },
          };
          await expect(
            runSessionTurn(state, ambiguousFailure, descriptor, { prompt: "unreceipted failure" }),
          ).rejects.toThrow("ambiguous provider failure");
        }

        const canonicalBeforeResume = await loadTranscript(state, descriptor.sessionId);
        expect(canonicalBeforeResume?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
        const binary = await fakeKimiAcpBinary(stateDir, capturePath);
        await expect(
          runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "must not use the older receipt" }),
        ).rejects.toThrow("latest canonical continuation boundary lacks a native receipt");
        expect(await pathExists(capturePath)).toBe(false);
      } finally {
        restore();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("denied: an upstream resume failure never falls back to session creation or records success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-resume-error-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      await runSessionTurn(state, bootstrapKimiAdapter(nativeKimiReceipt()), descriptor, { prompt: "first" });
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { resumeError: true });

      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "resume exactly" }),
      ).rejects.toThrow("Kimi ACP session resume failed; native session was not replaced");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.requests.map(({ method }) => method)).toEqual(["initialize", "session/resume"]);
      expect(captured.requests.some(({ method }) => method === "session/new")).toBe(false);

      const canonical = await loadTranscript(state, descriptor.sessionId);
      const latestAssistant = canonical?.messages.at(-1);
      expect(latestAssistant?.metadata?.error).toBe(true);
      expect(latestAssistant?.metadata?.receipt).toBeUndefined();
      expect(latestAssistant?.content).not.toContain("unknown session with provider detail");
      const completed = (await loadSessionEvents(state, descriptor.sessionId)).filter(
        (event): event is CompletedTurnEvent => event.type === "turn.completed",
      );
      expect(completed.at(-1)?.data.receipt).toBeUndefined();
      expect(completed.at(-1)?.data.error).toBe("Kimi ACP session resume failed; native session was not replaced");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("denied: resumed native model drift fails closed before mode configuration or prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-model-drift-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      await runSessionTurn(state, bootstrapKimiAdapter(nativeKimiReceipt()), descriptor, { prompt: "first" });
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { resumeModel: "drifted-model" });

      await expect(
        runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "must not cross model drift" }),
      ).rejects.toThrow("did not confirm the requested model configuration");
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
      expect(captured.requests.map(({ method }) => method)).toEqual(["initialize", "session/resume"]);
      expect(captured.requests.some(({ method }) => method === "session/prompt")).toBe(false);
      expect((await loadTranscript(state, descriptor.sessionId))?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("denied: malformed ACP session creation output is rejected without a receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-malformed-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { malformedNewSession: true });
      await expect(runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "first" })).rejects.toThrow(
        "Kimi ACP session creation response has an invalid provider session id",
      );
      const canonical = await loadTranscript(state, descriptor.sessionId);
      expect(canonical?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("denied: malformed provider protocol output fails closed without echoing raw bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-malformed-json-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { malformedProtocolJson: true });

      await expect(runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "first" })).rejects.toThrow(
        "Kimi ACP initialization failed",
      );
      expect(consoleError).not.toHaveBeenCalled();
      const canonical = await loadTranscript(state, descriptor.sessionId);
      expect(canonical?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
      expect(canonical?.messages.at(-1)?.content).not.toContain("RAW-SENSITIVE-MALFORMED-SENTIN");
    } finally {
      consoleError.mockRestore();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("denied: hung ACP control and prompt requests terminate within their sanitized deadlines", async () => {
    for (const [hangAt, expected, expectedMethods] of [
      ["initialize", "Kimi ACP initialization timed out", ["initialize"]],
      [
        "prompt",
        "Kimi ACP prompt timed out",
        ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt"],
      ],
    ] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agents-kimi-acp-timeout-${hangAt}-`));
      const stateDir = path.join(root, ".agents");
      const userHome = path.join(root, "user-home");
      const capturePath = path.join(root, "kimi-acp.json");
      const restore = withDisposableHome(stateDir, userHome);
      try {
        const state = sharedStateAt(root, stateDir, userHome);
        await seedKimiCanonicalStartup(state, stateDir);
        const descriptor = await createSession(state, {
          provider: "kimi",
          model: "kimi-test",
          mode: "chat",
          workdir: root,
        });
        const binary = await fakeKimiAcpBinary(stateDir, capturePath, { hangAt });
        const adapter = kimiSessionAdapter(binary, {
          // Allow the PowerShell launcher and fake ACP process to become
          // observable before exercising the deliberately short deadline.
          controlRequestMs: 2_000,
          promptMs: 200,
          shutdownMs: 100,
        });
        const startedAt = Date.now();
        await expect(runSessionTurn(state, adapter, descriptor, { prompt: "must finish bounded" })).rejects.toThrow(
          expected,
        );
        expect(Date.now() - startedAt).toBeLessThan(5_000);

        const captured = JSON.parse(await readFile(capturePath, "utf8")) as FakeKimiAcpCapture;
        expect(captured.requests.map(({ method }) => method)).toEqual([...expectedMethods]);
        const canonical = await loadTranscript(state, descriptor.sessionId);
        expect(canonical?.messages.at(-1)?.content).toBe(expected);
        expect(canonical?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
      } finally {
        restore();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("denied: a cross-session update fails closed without SDK logging or a receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-kimi-acp-wrong-session-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capturePath = path.join(root, "kimi-acp.json");
    const restore = withDisposableHome(stateDir, userHome);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedKimiCanonicalStartup(state, stateDir);
      const descriptor = await createSession(state, {
        provider: "kimi",
        model: "kimi-test",
        mode: "chat",
        workdir: root,
      });
      const binary = await fakeKimiAcpBinary(stateDir, capturePath, { wrongSessionUpdate: true });

      await expect(runSessionTurn(state, kimiSessionAdapter(binary), descriptor, { prompt: "first" })).rejects.toThrow(
        "Kimi ACP emitted an update for an unexpected native session",
      );
      expect(consoleError).not.toHaveBeenCalled();
      const canonical = await loadTranscript(state, descriptor.sessionId);
      expect(canonical?.messages.at(-1)?.metadata?.receipt).toBeUndefined();
      expect(canonical?.messages.at(-1)?.content).not.toContain("provider-secret-wrong-session");
    } finally {
      consoleError.mockRestore();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function pinFakeAgy(
  state: ReturnType<typeof sharedStateAt>,
  stateDir: string,
  capturePath: string,
  opts: {
    startupUpdater?: boolean;
    providerError?: string;
    selfMutate?: boolean;
    poison?: { binarySourcePath: string; registryPath: string; payloadPath: string };
  } = {},
): Promise<string> {
  const script = fakeAgyBinary(capturePath, opts);
  const binary = path.join(stateDir, "clis", "agy", "bin", script.name);
  await Bun.write(binary, script.content);
  if (script.executable) await chmod(binary, 0o700);
  await writeProviderRegistration(state, await inspectProviderExecutable("agy", binary, "1.1.1"));
  return binary;
}

/** Inject one synchronous mutation after the real Agy argv has been built. */
function mutateOnceDuringAgyBuildArgs(adapter: ReturnType<typeof agySessionAdapter>, mutate: () => void): void {
  const internals = adapter as unknown as {
    options: {
      buildArgs: (
        request: TurnRequest,
        transcript: SessionTranscript,
        descriptor: SessionDescriptor,
      ) => string[];
    };
  };
  const originalBuildArgs = internals.options.buildArgs;
  let mutated = false;
  internals.options.buildArgs = (request, currentTranscript, descriptor) => {
    const args = originalBuildArgs(request, currentTranscript, descriptor);
    if (!mutated) {
      mutated = true;
      mutate();
    }
    return args;
  };
}

/**
 * Coordinates an asynchronous executable replacement with the first physical
 * boundary read. Under the old order this happened after the executable hash;
 * the fixed order performs its final path/checksum attestation afterwards.
 */
function mutateOnceDuringAgyBoundaryVerification(
  adapter: ReturnType<typeof agySessionAdapter>,
  mutate: () => void,
): void {
  const internals = adapter as unknown as {
    options: { preflight?: (descriptor: SessionDescriptor) => Promise<unknown> };
  };
  const originalPreflight = internals.options.preflight;
  if (!originalPreflight) throw new Error("expected managed Agy preflight");
  internals.options.preflight = async (descriptor) => {
    const attestation = await originalPreflight(descriptor);
    if (!attestation || typeof attestation !== "object") throw new Error("expected managed Agy attestation");
    let scheduled = false;
    return new Proxy(attestation, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "clisDir" && !scheduled) {
          scheduled = true;
          queueMicrotask(mutate);
        }
        return value;
      },
    });
  };
}

describe("managed Agy provider boundary (issue #252)", () => {
  test("edge: runTurn forces the Agy updater opt-out after ambient and option aliases without changing non-Agy env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-env-force-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const controlCapture = path.join(root, "control-capture.txt");
    const restoreHome = withDisposableHome(stateDir, userHome);
    const restoreUpdate = withAmbientAgyUpdate("ambient-false");
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const descriptor: SessionDescriptor = {
        sessionId: "session-agy-env-force",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      const adapter = new CliProviderAdapter({
        id: "agy",
        displayName: "Agy",
        binary,
        buildArgs: () => ["--model", AGY_LOW_MODEL, "--print", "prompt"],
        env: {
          AGY_CLI_DISABLE_AUTO_UPDATE: "option-false",
          agy_cli_disable_auto_update: "option-alias-false",
        },
      });

      expect((await adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).error).toBeUndefined();
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");

      restoreUpdate();
      const restoreControlUpdate = withAmbientAgyUpdate();
      try {
        const controlScript = fakeAgyBinary(controlCapture);
        const controlBinary = path.join(root, `control-${controlScript.name}`);
        await Bun.write(controlBinary, controlScript.content);
        if (controlScript.executable) await chmod(controlBinary, 0o700);
        const control = new CliProviderAdapter({
          id: "codex",
          displayName: "Codex",
          binary: controlBinary,
          buildArgs: () => ["--model", "gpt-test", "--print", "prompt"],
          env: { AGY_CLI_DISABLE_AUTO_UPDATE: "caller-value" },
        });
        expect(
          (
            await control.runTurn(
              { ...descriptor, sessionId: "session-codex-env-control", provider: "codex", model: "gpt-test" },
              transcript(),
              { prompt: "hi" },
            )
          ).error,
        ).toBeUndefined();
        expect(parseCapture(await readFile(controlCapture, "utf8")).agyAutoUpdate).toBe("caller-value");
      } finally {
        restoreControlUpdate();
      }
    } finally {
      restoreUpdate();
      restoreHome();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("success: a managed agy/low turn reaches the provider with the exact prompt, concrete Low model, and an absolute canonical home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-success-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const promptText = "Reply with the single word ok.";
      const result = await runSessionTurn(state, adapter, descriptor, {
        prompt: promptText,
        executionPolicy: "read-only",
      });
      expect(result.error).toBeUndefined();
      expect(result.resolvedExecutionPolicy).toBe("read-only");

      // The exact prompt and the concrete Low model reach the provider boundary.
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.argv0).toBe("--sandbox");
      expect(captured.argv1).toBe("--mode");
      expect(captured.argv2).toBe("plan");
      expect(captured.argv3).toBe("--model");
      expect(captured.argv4).toBe(AGY_LOW_MODEL);
      expect(captured.argv5).toBe("--print");
      expect(captured.argc).toBe("7");
      const reachedPrompt = decodePrompt(captured);
      expect(reachedPrompt).toContain(promptText);
      expect(reachedPrompt).toContain("AGY-CANONICAL-CONTEXT");
      expect(reachedPrompt.match(/Reply with the single word ok\./g)?.length).toBe(1);

      // The provider home stays canonical and absolute; no user-profile fallback.
      const providerHome = path.join(stateDir, "clis", "agy");
      expect(captured.geminiDir).toBe(path.join(providerHome, ".gemini"));
      expect(captured.home).toBe(providerHome);
      expect(captured.userProfile).toBe(providerHome);
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");
      expect(captured.startupUpdaterDecision).toBe("disabled");
      expect(path.isAbsolute(captured.geminiDir)).toBe(true);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);

      // The resolved concrete model is recorded truthfully in canonical session state.
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      const receipt = assistant?.metadata?.receipt as Record<string, unknown> | undefined;
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };
      // Exact allowlist: the manager-recorded receipt carries only the
      // issue-required model/request evidence — no env, paths, auth, prompt,
      // or secret data.
      expect(receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("success: a managed agy/low turn accepts a safe OS-level ancestor alias and stays inside the physical attested bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-ancestor-alias-"));
    const physicalRoot = path.join(root, "physical");
    const aliasRoot = path.join(root, "alias");
    const physicalStateDir = path.join(physicalRoot, ".agents");
    const aliasStateDir = path.join(aliasRoot, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(aliasStateDir, userHome);
    try {
      // Create the alias parent: junction on Windows, dir symlink on POSIX.
      await mkdir(physicalRoot, { recursive: true });
      await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

      const state = sharedStateAt(root, aliasStateDir, userHome);
      await seedCanonicalStartup(state, aliasStateDir);
      // pinFakeAgy writes through the alias, but realpath resolves to physical.
      const binary = await pinFakeAgy(state, aliasStateDir, capture);

      // Prove the configured path is textually different from its realpath.
      const resolvedBinary = await realpath(binary);
      expect(resolvedBinary).not.toBe(binary);
      expect(binary.startsWith(aliasRoot)).toBe(true);

      await Bun.write(path.join(aliasStateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const promptText = "Reply with the single word ok.";
      const result = await runSessionTurn(state, adapter, descriptor, { prompt: promptText });
      expect(result.error).toBeUndefined();

      // Executed exactly once.
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.argc).toBe("7");
      expect(captured.argv4).toBe(AGY_LOW_MODEL);
      const reachedPrompt = decodePrompt(captured);
      expect(reachedPrompt).toContain(promptText);

      // Remains under the physical attested bin.
      const physicalBinDir = await realpath(path.join(physicalStateDir, "clis", "agy", "bin"));
      const relativeToBin = path.relative(physicalBinDir, resolvedBinary);
      expect(relativeToBin.startsWith("..") || path.isAbsolute(relativeToBin)).toBe(false);

      // No forbidden user-home .gemini.
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("edge: a spaced Windows-style canonical root stays quoted and isolated from the user-profile .gemini", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents agy edge "));
    const stateDir = path.join(root, ".agents state");
    const userHome = path.join(root, "user home");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const descriptor: SessionDescriptor = {
        sessionId: "session-edge",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      const providerHome = path.join(stateDir, "clis", "agy");
      const env = canonicalProviderEnv("agy", descriptor);

      expect(env.GEMINI_DIR).toBe(path.join(providerHome, ".gemini"));
      expect(env.HOME).toBe(providerHome);
      expect(env.USERPROFILE).toBe(providerHome);
      expect(path.isAbsolute(env.GEMINI_DIR)).toBe(true);
      expect(env.GEMINI_DIR.startsWith(path.resolve(stateDir))).toBe(true);
      // No resolution path may collapse back to the user-profile .gemini directory.
      expect(env.GEMINI_DIR).not.toBe(path.join(userHome, ".gemini"));
      expect(env.USERPROFILE).not.toBe(userHome);
      expect(env.HOME).not.toBe(userHome);

      // The low tier resolves to the concrete authenticated Low model.
      expect(resolveAgyModel("low")).toMatchObject({ concreteModel: AGY_LOW_MODEL, effort: "low" });
      const args = buildProviderArgs("agy", "low", { prompt: "hello edge" }, transcript());
      expect(args).toEqual([
        "--sandbox",
        "--mode",
        "plan",
        "--model",
        AGY_LOW_MODEL,
        "--print",
        "hello edge",
      ]);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: missing canonical auth fails closed before launch and leaves no forbidden home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-denied-auth-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      // Deliberately no clis/agy/.gemini/oauth_creds.json.
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-denied-auth",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        "authentication is missing",
      );
      // The provider process never launched and no standalone home was created.
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: pinned-binary checksum drift (self-update) fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-denied-drift-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      // Simulate a self-update replacing the pinned executable behind the pin.
      await Bun.write(binary, `${fakeAgyBinary(capture).content}\n# drifted self-update\n`);
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-denied-drift",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("drift");
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a config-root junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-config-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      // Relocate the config root outside the provider home and link it back in.
      const outside = path.join(root, "escaped-config");
      await mkdir(outside, { recursive: true });
      await Bun.write(path.join(outside, "oauth_creds.json"), '{"token":"redacted"}');
      await symlink(
        outside,
        path.join(stateDir, "clis", "agy", ".gemini"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-config-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a provider-home junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-home-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Build the real provider home outside the canonical root and link it in.
      const outsideHome = path.join(root, "escaped-home");
      await mkdir(path.join(outsideHome, "bin"), { recursive: true });
      await mkdir(path.join(stateDir, "clis"), { recursive: true });
      await symlink(
        outsideHome,
        path.join(stateDir, "clis", "agy"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(outsideHome, ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-home-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a directory masquerading as the credential fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-dir-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await mkdir(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), { recursive: true });
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-auth-dir",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("not a regular file");
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a credential symlink fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-symlink-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      const outsideCreds = path.join(root, "escaped-creds.json");
      await Bun.write(outsideCreds, '{"token":"redacted"}');
      await mkdir(path.dirname(authPath), { recursive: true });
      try {
        await symlink(outsideCreds, authPath, "file");
      } catch {
        // Conditional fixture: file symlinks need privilege on some Windows hosts.
        return;
      }
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-auth-symlink",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Windows does not honor chmod read bits, so the unreadable fixture is
  // posix-only; the implementation's open/close readability check covers both.
  (process.platform === "win32" ? test.skip : test)(
    "denied: an unreadable credential fails closed before launch",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-unreadable-"));
      const stateDir = path.join(root, ".agents");
      const userHome = path.join(root, "user-home");
      const capture = path.join(root, "agy-capture.txt");
      const restore = withDisposableHome(stateDir, userHome);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      try {
        const state = sharedStateAt(root, stateDir, userHome);
        await ensureSharedState(state);
        const binary = await pinFakeAgy(state, stateDir, capture);
        await Bun.write(authPath, '{"token":"redacted"}');
        await chmod(authPath, 0o000);
        const adapter = agySessionAdapter(binary);
        const descriptor: SessionDescriptor = {
          sessionId: "session-auth-unreadable",
          provider: "agy",
          model: "low",
          mode: "chat",
          workdir: root,
          stateDir,
        };
        await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("not readable");
        expect(await pathExists(capture)).toBe(false);
        expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
      } finally {
        restore();
        await chmod(authPath, 0o600).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("denied: coordinated registry and binary poison during launch preparation cannot replace S0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-poison-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const originalCapture = path.join(root, "agy-original-capture.txt");
    const replacementCapture = path.join(root, "agy-replacement-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, originalCapture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const initialRegistry = await readProviderRegistry(state);
      const initialRegistration = initialRegistry.providers.agy!;
      expect((await verifyProviderRegistration(initialRegistration)).ok).toBe(true);

      const replacementSuccess = "C3_REPLACEMENT_EXECUTED";
      const replacementScript = fakeAgyBinary(replacementCapture);
      const replacementContent = replacementScript.content.replaceAll("agy-probe-ok", replacementSuccess);
      const replacementSource = path.join(root, `replacement-${replacementScript.name}`);
      await Bun.write(replacementSource, replacementContent);
      if (replacementScript.executable) await chmod(replacementSource, 0o700);
      const inspectedReplacement = await inspectProviderExecutable(
        "agy",
        replacementSource,
        initialRegistration.version,
        initialRegistration.pinnedAt,
      );
      const poisonedRegistration = {
        ...initialRegistration,
        sha256: inspectedReplacement.sha256,
      };
      const poisonedRegistry = {
        schemaVersion: 1,
        providers: { ...initialRegistry.providers, agy: poisonedRegistration },
      };
      const registryPath = stateV2Paths(state).providersFile;
      const poisonedPayload = `${JSON.stringify(poisonedRegistry, null, 2)}\n`;

      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBuildArgs(adapter, () => {
        writeFileSync(binary, replacementContent, "utf8");
        writeFileSync(registryPath, poisonedPayload, "utf8");
      });
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const promptSentinel = "C3_PROMPT_MUST_NOT_REACH_PROVIDER";

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: promptSentinel })).rejects.toThrow(
        "immediately before launch",
      );

      // S1 is internally valid for the replacement bytes. A final registry
      // reread would bless it, while immutable S0 must reject before execution.
      const poisonedCurrent = (await readProviderRegistry(state)).providers.agy!;
      expect(poisonedCurrent).toEqual(poisonedRegistration);
      expect((await verifyProviderRegistration(poisonedCurrent)).ok).toBe(true);
      expect(await pathExists(originalCapture)).toBe(false);
      expect(await pathExists(replacementCapture)).toBe(false);

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("immediately before launch");
      expect(assistant?.content).not.toContain(replacementSuccess);
      expect(assistant?.content).not.toContain(promptSentinel);
      expect(assistant?.content).not.toContain("GEMINI_DIR=");
      expect(assistant?.content).not.toContain("HOME=");
      expect(assistant?.content).not.toContain("USERPROFILE=");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: async executable replacement during boundary verification is caught before spawn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-interval-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const originalCapture = path.join(root, "agy-original-capture.txt");
    const replacementCapture = path.join(root, "agy-replacement-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, originalCapture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const replacementSuccess = "ASYNC_REPLACEMENT_EXECUTED";
      const replacementScript = fakeAgyBinary(replacementCapture);
      const replacementContent = replacementScript.content.replaceAll("agy-probe-ok", replacementSuccess);
      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBoundaryVerification(adapter, () => writeFileSync(binary, replacementContent, "utf8"));
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const promptSentinel = "ASYNC_PROMPT_MUST_NOT_REACH_PROVIDER";

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: promptSentinel })).rejects.toThrow(
        "immediately before launch",
      );

      expect(await pathExists(originalCapture)).toBe(false);
      expect(await pathExists(replacementCapture)).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("attested executable checksum changed");
      expect(assistant?.content).not.toContain(replacementSuccess);
      expect(assistant?.content).not.toContain(promptSentinel);
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: an output-read failure cannot bypass postflight executable drift attestation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-postflight-output-error-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    let exited: Promise<number> | undefined;
    let spawnSpy: ReturnType<typeof spyOn> | undefined;
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const outputFailure = "synthetic stdout read failure";
      const replacement = `${fakeAgyBinary(capture).content}\n# persistent replacement before exit\n`;
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(outputFailure));
          },
        });
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        exited = new Promise<number>((resolve, reject) => {
          setTimeout(() => {
            try {
              writeFileSync(binary, replacement, "utf8");
              resolve(0);
            } catch (error) {
              reject(error);
            }
          }, 25);
        });
        return { stdout, stderr, exited } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn);

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "must not survive drift" })).rejects.toThrow(
        "after the managed run",
      );

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("attested executable checksum changed");
      expect(assistant?.content).not.toContain(outputFailure);
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      await exited?.catch(() => {});
      spawnSpy?.mockRestore();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: auth removed during launch preparation fails before the streaming fallback can execute", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-auth-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      await Bun.write(authPath, '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBuildArgs(adapter, () => unlinkSync(authPath));
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const chunks: Array<{ type: string; delta?: string }> = [];
      const collect = async () => {
        for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "auth temporal probe" })) {
          chunks.push(chunk);
        }
      };

      await expect(collect()).rejects.toThrow("immediately before launch");
      expect(await pathExists(capture)).toBe(false);
      expect(chunks.some((chunk) => chunk.type === "text" || chunk.delta?.includes("agy-probe-ok"))).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("canonical authentication is missing immediately before launch");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: executable replaced during the managed run fails closed after exit and persists no success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-midrun-drift-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { selfMutate: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "hi" })).rejects.toThrow("drift");

      // The fake provider emitted output and exited cleanly, yet the post-exit
      // re-verification refuses the result: no success content and no receipt.
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).toContain("after the managed run");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: executable replaced during the managed run fails closed through the streaming path with no success and no receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-midrun-stream-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { selfMutate: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const chunks: Array<{ type: string; delta?: string }> = [];
      const collect = async () => {
        for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "hi" })) {
          chunks.push(chunk);
        }
      };
      await expect(collect()).rejects.toThrow("drift");

      // No success chunk streamed, and the persisted turn carries only the error.
      expect(chunks.some((chunk) => chunk.delta?.includes("agy-probe-ok"))).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: a coordinated registry+binary swap during the run cannot bless the replaced executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-registry-swap-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);

      // Pre-bake the swapped executable and a registry payload that blesses it;
      // the fake applies both during the run, as a malicious self-update would.
      const swappedSource = path.join(root, "agy-swapped");
      await Bun.write(swappedSource, `${fakeAgyBinary(capture).content}\n# coordinated swap\n`);
      const registryPath = stateV2Paths(state).providersFile;
      const payloadPath = path.join(root, "poisoned-registry.json");
      const binary = await pinFakeAgy(state, stateDir, capture, {
        poison: { binarySourcePath: swappedSource, registryPath, payloadPath },
      });
      const registry = await readProviderRegistry(state);
      const registration = registry.providers.agy!;
      // Build the poisoned registration from the real swapped fixture using the
      // production registry helpers, so the alternate executable path,
      // realpath, and sha256 all match. A hypothetical postflight that reread
      // and followed the registry would accept this target.
      const poisonedRegistration = await inspectProviderExecutable("agy", swappedSource, registration.version);
      expect((await verifyProviderRegistration(poisonedRegistration)).ok).toBe(true);
      await Bun.write(
        payloadPath,
        `${JSON.stringify({ schemaVersion: 1, providers: { agy: poisonedRegistration } }, null, 2)}\n`,
      );
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      // The real snapshot-only attestation still rejects the replaced launch
      // executable because postflight never rereads the mutable registry.
      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "hi" })).rejects.toThrow("drift");

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).toContain("after the managed run");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("stream: a managed agy/low turn records the truthful receipt through the streaming path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-stream-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const chunks: Array<{ type: string; delta?: string }> = [];
      for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "Reply with the single word ok." })) {
        chunks.push(chunk);
      }
      expect(chunks.some((chunk) => chunk.type === "text" && chunk.delta?.includes("agy-probe-ok"))).toBe(true);

      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");
      expect(captured.startupUpdaterDecision).toBe("disabled");
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.metadata?.error).toBeUndefined();
      const receipt = assistant?.metadata?.receipt as Record<string, unknown> | undefined;
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };
      // Exact allowlist: the manager-recorded receipt carries only the
      // issue-required model/request evidence — no env, paths, auth, prompt,
      // or secret data.
      expect(receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("edge: ordinary provider errors keep the truthful receipt in normal and stream paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-provider-error-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const providerError = "fake provider rejected the request";
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true, providerError });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };

      const normalDescriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const normalResult = await runSessionTurn(state, adapter, normalDescriptor, { prompt: "normal error" });
      expect(normalResult.error).toBe("provider execution failed");
      expect(JSON.stringify(normalResult)).not.toContain(providerError);
      expect(normalResult.receipt).toEqual(expectedReceipt);
      const normalTranscript = await loadTranscript(state, normalDescriptor.sessionId);
      const normalAssistant = normalTranscript?.messages.find((message) => message.role === "assistant");
      expect(normalAssistant?.metadata?.error).toBe(true);
      expect(normalAssistant?.metadata?.receipt).toEqual(expectedReceipt);
      const normalEvents = await loadSessionEvents(state, normalDescriptor.sessionId);
      expect(completedTurnEvent(normalEvents).data.receipt).toEqual(expectedReceipt);
      expect(JSON.stringify(normalEvents)).not.toContain(providerError);

      const streamDescriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const chunks: Array<{ type: string; error?: string }> = [];
      for await (const chunk of streamSessionTurn(state, adapter, streamDescriptor, { prompt: "stream error" })) {
        chunks.push(chunk);
      }
      expect(chunks.some((chunk) => chunk.type === "error" && chunk.error === "provider execution failed")).toBe(true);
      expect(JSON.stringify(chunks)).not.toContain(providerError);
      const streamTranscript = await loadTranscript(state, streamDescriptor.sessionId);
      const streamAssistant = streamTranscript?.messages.find((message) => message.role === "assistant");
      expect(streamAssistant?.metadata?.error).toBe(true);
      expect(streamAssistant?.metadata?.receipt).toEqual(expectedReceipt);
      const streamEvents = await loadSessionEvents(state, streamDescriptor.sessionId);
      expect(completedTurnEvent(streamEvents).data.receipt).toEqual(expectedReceipt);
      expect(JSON.stringify(streamEvents)).not.toContain(providerError);

      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.startupUpdaterDecision).toBe("disabled");
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: a bin junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-bin-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Build the real bin directory outside the canonical provider home and
      // link it in as clis/agy/bin. The executable is physically outside the
      // canonical boundary, so a launch through the canonical path escapes.
      const outsideBin = path.join(root, "escaped-bin");
      await mkdir(outsideBin, { recursive: true });
      await mkdir(path.join(stateDir, "clis", "agy"), { recursive: true });
      await symlink(
        outsideBin,
        path.join(stateDir, "clis", "agy", "bin"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-bin-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: an executable symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-exe-symlink-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Create a real executable outside the canonical bin and link it in as
      // the configured executable. The canonical bin directory stays physical,
      // but the executable itself is a symlink escape.
      const outsideBin = path.join(root, "escaped-bin");
      await mkdir(outsideBin, { recursive: true });
      const script = fakeAgyBinary(capture);
      const outsideExe = path.join(outsideBin, script.name);
      await Bun.write(outsideExe, script.content);
      if (script.executable) await chmod(outsideExe, 0o700);

      const canonicalBin = path.join(stateDir, "clis", "agy", "bin");
      await mkdir(canonicalBin, { recursive: true });
      const binary = path.join(canonicalBin, script.name);
      try {
        await symlink(outsideExe, binary, "file");
      } catch {
        // Conditional fixture: file symlinks need privilege on some Windows hosts.
        return;
      }
      await writeProviderRegistration(state, await inspectProviderExecutable("agy", binary, "1.1.1"));
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-exe-symlink",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
