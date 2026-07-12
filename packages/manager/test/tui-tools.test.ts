import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../src/state";
import { createSession, loadSessionEvents, loadTranscript } from "../../harness/session";
import {
  createTuiTools,
  executeToolCalls,
  parseToolCalls,
  renderToolsPrompt,
  runSessionTurnWithTools,
  type AgentToolContext,
  type ProviderListing,
} from "../../harness/tools";
import type { ProviderAdapter, SessionDescriptor, TurnRequest, TurnResult } from "../../harness/session";

function fakeContext(
  descriptor: SessionDescriptor,
  providers: ProviderListing[],
): AgentToolContext & { statusCalls: string[]; switches: Array<{ provider: string; model?: string }> } {
  const statusCalls: string[] = [];
  const switches: Array<{ provider: string; model?: string }> = [];
  const ctx: AgentToolContext = {
    state: {} as ReturnType<typeof sharedState>,
    descriptor,
    status(message) {
      statusCalls.push(message);
    },
    async listProviders() {
      return providers;
    },
    async switchProvider(provider, model) {
      switches.push({ provider, model });
      ctx.descriptor = { ...ctx.descriptor, provider, model: model ?? ctx.descriptor.model };
    },
  };
  return Object.assign(ctx, { statusCalls, switches });
}

describe("agent-controlled TUI tools", () => {
  test("renderToolsPrompt includes all tools", () => {
    const prompt = renderToolsPrompt(createTuiTools());
    expect(prompt).toContain("switch_provider");
    expect(prompt).toContain("switch_model");
    expect(prompt).toContain("set_status");
    expect(prompt).toContain("list_providers");
    expect(prompt).toContain("<tool_call>");
  });

  test("parseToolCalls extracts tool invocations", () => {
    const content = `I need to switch.\n<tool_call>{"name":"switch_provider","arguments":{"provider_id":"codex"}}</tool_call>\nDone.`;
    const calls = parseToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("switch_provider");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ provider_id: "codex" });
  });

  test("switch_provider handler switches to the default model", async () => {
    const tools = createTuiTools();
    const descriptor = { provider: "kimi", model: "kimi-k2" } as SessionDescriptor;
    const ctx = fakeContext(descriptor, [
      { id: "kimi", available: true, models: ["kimi-k2", "moonshot-v1-8k"] },
      { id: "codex", available: true, models: ["codex-latest"] },
    ]);
    const result = await executeToolCalls(
      [{ id: "c1", type: "function", function: { name: "switch_provider", arguments: JSON.stringify({ provider_id: "codex" }) } }],
      tools,
      ctx,
    );
    expect(result[0].content).toContain("codex");
    expect(result[0].content).toContain("codex-latest");
    expect(ctx.switches).toEqual([{ provider: "codex", model: "codex-latest" }]);
    expect(ctx.descriptor.provider).toBe("codex");
    expect(ctx.descriptor.model).toBe("codex-latest");
  });

  test("switch_model handler validates the model", async () => {
    const tools = createTuiTools();
    const descriptor = { provider: "kimi", model: "kimi-k2" } as SessionDescriptor;
    const ctx = fakeContext(descriptor, [
      { id: "kimi", available: true, models: ["kimi-k2", "moonshot-v1-8k"] },
    ]);
    const ok = await executeToolCalls(
      [{ id: "c1", type: "function", function: { name: "switch_model", arguments: JSON.stringify({ model_id: "moonshot-v1-8k" }) } }],
      tools,
      ctx,
    );
    expect(ok[0].content).toContain("moonshot-v1-8k");

    const bad = await executeToolCalls(
      [{ id: "c2", type: "function", function: { name: "switch_model", arguments: JSON.stringify({ model_id: "codex-latest" }) } }],
      tools,
      ctx,
    );
    expect(bad[0].content).toContain("error:");
  });

  test("set_status handler dispatches the message", async () => {
    const tools = createTuiTools();
    const ctx = fakeContext({ provider: "fake", model: "test" } as SessionDescriptor, []);
    const result = await executeToolCalls(
      [{ id: "c1", type: "function", function: { name: "set_status", arguments: JSON.stringify({ message: "working" }) } }],
      tools,
      ctx,
    );
    expect(ctx.statusCalls).toEqual(["working"]);
    expect(result[0].content).toContain("working");
  });

  test("list_providers handler returns provider listings", async () => {
    const tools = createTuiTools();
    const listings: ProviderListing[] = [
      { id: "kimi", available: true, models: ["kimi-k2"], notes: [] },
      { id: "codex", available: false, models: ["codex-latest"], notes: ["missing binary"] },
    ];
    const ctx = fakeContext({ provider: "fake", model: "test" } as SessionDescriptor, listings);
    const result = await executeToolCalls(
      [{ id: "c1", type: "function", function: { name: "list_providers", arguments: "{}" } }],
      tools,
      ctx,
    );
    expect(JSON.parse(result[0].content)).toEqual(listings);
  });

  test("runSessionTurnWithTools records tool calls and results in the transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-tui-tools-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "fake", model: "test", mode: "chat" });

      const adapter = new (class implements ProviderAdapter {
        readonly id = "fake";
        readonly displayName = "Fake";
        readonly supportsStreaming = false;
        calls = 0;
        async startSession(): Promise<void> {}
        async continueSession(): Promise<void> {}
        async runTurn(_descriptor: SessionDescriptor, _transcript: unknown, request: TurnRequest): Promise<TurnResult> {
          this.calls += 1;
          if (this.calls === 1) {
            return {
              content: `<tool_call>{"name":"set_status","arguments":{"message":"${request.prompt}"}}</tool_call>`,
              role: "assistant",
            };
          }
          return { content: `done: ${request.prompt}`, role: "assistant", finishReason: "stop" };
        }
      })();

      const ctx = fakeContext(descriptor, [{ id: "fake", available: true, models: ["test"] }]);
      const { result } = await runSessionTurnWithTools(state, descriptor, { prompt: "hello" }, {
        tools: createTuiTools(),
        ctx,
        resolveAdapter: () => adapter,
      });

      expect(result.content).toBe("done: hello");
      expect(ctx.statusCalls).toEqual(["hello"]);

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.messages.some((m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0)).toBe(true);
      expect(transcript?.messages.some((m) => m.role === "tool" && m.name === "set_status")).toBe(true);
      expect(transcript?.messages.some((m) => m.role === "assistant" && m.content === "done: hello")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failover scenario: provider signals rate-limit, agent switches, turn completes on the other provider", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-tui-failover-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const descriptor = await createSession(state, { provider: "primary", model: "p1", mode: "chat" });

      class PrimaryAdapter implements ProviderAdapter {
        readonly id = "primary";
        readonly displayName = "Primary";
        readonly supportsStreaming = false;
        async startSession(): Promise<void> {}
        async continueSession(): Promise<void> {}
        async runTurn(): Promise<TurnResult> {
          return {
            content: `<tool_call>{"name":"switch_provider","arguments":{"provider_id":"secondary"}}</tool_call>`,
            role: "assistant",
          };
        }
      }

      class SecondaryAdapter implements ProviderAdapter {
        readonly id = "secondary";
        readonly displayName = "Secondary";
        readonly supportsStreaming = false;
        async startSession(): Promise<void> {}
        async continueSession(): Promise<void> {}
        async runTurn(_descriptor: SessionDescriptor, _transcript: unknown, request: TurnRequest): Promise<TurnResult> {
          return {
            content: `secondary: ${request.prompt}`,
            role: "assistant",
            finishReason: "stop",
            usage: { tokensIn: 3, tokensOut: 4 },
          };
        }
      }

      const primary = new PrimaryAdapter();
      const secondary = new SecondaryAdapter();
      const ctx = fakeContext(descriptor, [
        { id: "primary", available: true, models: ["p1"] },
        { id: "secondary", available: true, models: ["s1"] },
      ]);

      const { result, descriptor: finalDescriptor } = await runSessionTurnWithTools(state, descriptor, { prompt: "hello" }, {
        tools: createTuiTools(),
        ctx,
        resolveAdapter: (d) => (d.provider === "primary" ? primary : secondary),
      });

      expect(result.content).toBe("secondary: hello");
      expect(finalDescriptor.provider).toBe("secondary");
      expect(ctx.switches).toEqual([{ provider: "secondary", model: "s1" }]);

      const transcript = await loadTranscript(state, descriptor.sessionId);
      expect(transcript?.provider).toBe("secondary");
      expect(transcript?.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.function.name === "switch_provider"))).toBe(true);
      expect(transcript?.messages.some((m) => m.role === "tool")).toBe(true);
      expect(transcript?.messages.some((m) => m.role === "assistant" && m.content === "secondary: hello")).toBe(true);
      const events = await loadSessionEvents(state, descriptor.sessionId);
      expect(events.map((event) => event.type)).toEqual([
        "session.created",
        "turn.started",
        "message.appended",
        "message.appended",
        "message.appended",
        "provider.switched",
        "message.appended",
        "message.appended",
        "turn.completed",
      ]);
      const completed = events.at(-1);
      expect(completed?.type === "turn.completed" ? completed.data.usage : undefined).toEqual({
        tokensIn: 3,
        tokensOut: 4,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
