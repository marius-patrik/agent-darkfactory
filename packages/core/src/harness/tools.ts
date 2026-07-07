import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionState,
  SessionStateRoot,
  SessionTranscript,
  ToolCall,
  TurnRequest,
  TurnResult,
} from "./session";
import { loadSessionState, loadTranscript, saveSessionState, saveTranscript } from "./session";

export interface AgentToolParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, AgentToolParameter>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<unknown>;
}

export interface ProviderListing {
  id: string;
  displayName?: string;
  available: boolean;
  models: string[];
  notes?: string[];
}

export interface AgentToolContext {
  state: SessionStateRoot;
  descriptor: SessionDescriptor;
  status(message: string): void;
  listProviders(): Promise<ProviderListing[]>;
  switchProvider(provider: string, model?: string): Promise<void>;
}

export interface RunWithToolsOptions {
  tools: AgentTool[];
  ctx: AgentToolContext;
  resolveAdapter: (descriptor: SessionDescriptor) => ProviderAdapter;
  maxRounds?: number;
}

export function renderToolsPrompt(tools: AgentTool[]): string {
  const lines = [
    "You have access to tools. To call a tool, output one or more lines exactly like:",
    '<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>',
    "",
    "Available tools:",
  ];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
    lines.push(`  parameters: ${JSON.stringify(tool.parameters)}`);
  }
  return lines.join("\n");
}

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof parsed.name === "string") {
        calls.push({
          id: `call_${calls.length + 1}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      // Ignore malformed tool call blocks.
    }
  }
  return calls;
}

export async function executeToolCalls(
  calls: ToolCall[],
  tools: AgentTool[],
  ctx: AgentToolContext,
): Promise<{ id: string; name?: string; content: string }[]> {
  const results: { id: string; name?: string; content: string }[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.function.name);
    let content: string;
    try {
      if (!tool) throw new Error(`unknown tool: ${call.function.name}`);
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      const result = await tool.handler(args, ctx);
      content = typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      content = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    results.push({ id: call.id, name: call.function.name, content });
  }
  return results;
}

export function createTuiTools(): AgentTool[] {
  return [
    {
      name: "switch_provider",
      description:
        "Switch the session to a different provider. The next turn will use the new provider; context is preserved.",
      parameters: {
        type: "object",
        properties: {
          provider_id: {
            type: "string",
            description: "Provider identifier, e.g. 'codex', 'claude', 'kimi', or 'agy'.",
          },
        },
        required: ["provider_id"],
      },
      handler: async (args, ctx) => {
        const providerId = String(args.provider_id);
        const providers = await ctx.listProviders();
        const provider = providers.find((p) => p.id === providerId);
        if (!provider) throw new Error(`provider '${providerId}' is not configured`);
        const model = provider.models[0] ?? "default";
        await ctx.switchProvider(providerId, model);
        return { status: "ok", provider: providerId, model };
      },
    },
    {
      name: "switch_model",
      description: "Switch to a different model on the current provider.",
      parameters: {
        type: "object",
        properties: {
          model_id: {
            type: "string",
            description: "Model identifier for the current provider.",
          },
        },
        required: ["model_id"],
      },
      handler: async (args, ctx) => {
        const modelId = String(args.model_id);
        const providers = await ctx.listProviders();
        const provider = providers.find((p) => p.id === ctx.descriptor.provider);
        const models = provider?.models ?? [];
        if (!models.includes(modelId)) {
          throw new Error(`model '${modelId}' is not available for provider '${ctx.descriptor.provider}'`);
        }
        await ctx.switchProvider(ctx.descriptor.provider, modelId);
        return { status: "ok", provider: ctx.descriptor.provider, model: modelId };
      },
    },
    {
      name: "set_status",
      description: "Set a short message in the TUI status bar.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Status message to display.",
          },
        },
        required: ["message"],
      },
      handler: async (args, ctx) => {
        const message = String(args.message);
        ctx.status(message);
        return { status: "ok", message };
      },
    },
    {
      name: "list_providers",
      description: "List configured providers, their models, and current availability.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async (_args, ctx) => ctx.listProviders(),
    },
  ];
}

export async function runSessionTurnWithTools(
  state: SessionStateRoot,
  descriptor: SessionDescriptor,
  request: TurnRequest,
  options: RunWithToolsOptions,
): Promise<{ result: TurnResult; descriptor: SessionDescriptor }> {
  const { tools, ctx, resolveAdapter, maxRounds = 5 } = options;
  const transcript = (await loadTranscript(state, descriptor.sessionId)) ?? emptyTranscript(descriptor);
  injectToolSystemPrompt(transcript, tools, request.systemPrompt);
  transcript.messages.push({ role: "user", content: request.prompt });

  let currentDescriptor = descriptor;
  let finalResult: TurnResult | undefined;

  for (let round = 0; round < maxRounds; round += 1) {
    const adapter = resolveAdapter(currentDescriptor);
    await adapter.startSession(currentDescriptor);
    await adapter.continueSession(currentDescriptor, transcript);
    const result = await adapter.runTurn(currentDescriptor, transcript, request);

    if (result.error) {
      transcript.messages.push({ role: "assistant", content: result.error, metadata: { error: true } });
      finalResult = result;
      break;
    }

    const toolCalls = parseToolCalls(result.content);
    if (toolCalls.length === 0) {
      transcript.messages.push({
        role: "assistant",
        content: result.content,
        metadata: {
          usage: result.usage,
          quota: result.quota,
          finishReason: result.finishReason,
        },
      });
      finalResult = result;
      break;
    }

    const visibleContent = result.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
    transcript.messages.push({
      role: "assistant",
      content: visibleContent,
      toolCalls,
      metadata: {
        usage: result.usage,
        quota: result.quota,
        finishReason: result.finishReason,
      },
    });

    const toolResults = await executeToolCalls(toolCalls, tools, ctx);
    for (const toolResult of toolResults) {
      transcript.messages.push({
        role: "tool",
        content: toolResult.content,
        toolCallId: toolResult.id,
        name: toolResult.name,
      });
    }

    currentDescriptor = ctx.descriptor;
  }

  if (!finalResult) {
    const error = "tool rounds exhausted without a final response";
    finalResult = { content: "", role: "assistant", error };
    transcript.messages.push({ role: "assistant", content: error, metadata: { error: true } });
  }

  const sessionState = (await loadSessionState(state, descriptor.sessionId)) ?? emptyState(descriptor);
  sessionState.turnCount += 1;
  const now = new Date().toISOString();
  sessionState.lastTurnAt = now;
  sessionState.provider = currentDescriptor.provider;
  sessionState.model = currentDescriptor.model;
  transcript.provider = currentDescriptor.provider;
  transcript.model = currentDescriptor.model;
  transcript.updatedAt = now;

  await Promise.all([saveTranscript(state, transcript), saveSessionState(state, sessionState)]);
  return { result: finalResult, descriptor: currentDescriptor };
}

function injectToolSystemPrompt(transcript: SessionTranscript, tools: AgentTool[], systemPrompt?: string): void {
  const toolPrompt = renderToolsPrompt(tools);
  const parts = [systemPrompt, toolPrompt].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return;
  const content = parts.join("\n\n");
  const existing = transcript.messages.find((m) => m.role === "system");
  if (!existing) {
    transcript.messages.unshift({ role: "system", content });
  }
}

function emptyTranscript(descriptor: SessionDescriptor): SessionTranscript {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    provider: descriptor.provider,
    model: descriptor.model,
    mode: descriptor.mode,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function emptyState(descriptor: SessionDescriptor): SessionState {
  return {
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    workdir: descriptor.workdir,
    provider: descriptor.provider,
    model: descriptor.model,
    mode: descriptor.mode,
    turnCount: 0,
    metadata: {},
  };
}
