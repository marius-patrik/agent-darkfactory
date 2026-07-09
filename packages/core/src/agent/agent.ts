import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import { resolveModel, type ProviderName } from "../providers/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTree } from "./tools.js";

const MAX_STEPS = 12;

export interface AgentOptions {
  provider?: ProviderName;
  model?: string;
}

export interface QueryResult {
  answer: string;
  steps: number;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
}

async function promptContext(kb: KnowledgeBase, mode: "query" | "mutate" | "chat") {
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree()]);
  return { existingTypes: types, treeSummary: formatTree(tree), mode };
}

function pickModel(options: AgentOptions): Promise<LanguageModel> {
  return resolveModel(options.provider, options.model);
}

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query");
  const result = await generateText({
    model: await pickModel(options),
    system: buildSystemPrompt(ctx),
    prompt: question,
    tools: buildReadTools(kb),
    stopWhen: stepCountIs(MAX_STEPS),
  });
  return { answer: result.text, steps: result.steps.length };
}

/** Knowledge add/update — full toolset, low temperature. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {}
): Promise<MutationResult> {
  const ctx = await promptContext(kb, "mutate");
  const filesChanged = new Set<string>();
  const result = await generateText({
    model: await pickModel(options),
    system: buildSystemPrompt(ctx),
    prompt: instruction,
    tools: { ...buildReadTools(kb), ...buildWriteTools(kb, filesChanged) },
    stopWhen: stepCountIs(MAX_STEPS),
    temperature: 0.2,
  });
  return { summary: result.text, filesChanged: [...filesChanged].sort(), steps: result.steps.length };
}

/** Interactive chat — full toolset, streaming. Caller converts to a UI stream response. */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
) {
  const ctx = await promptContext(kb, "chat");
  const filesChanged = new Set<string>();
  const result = streamText({
    model: await pickModel(options),
    system: buildSystemPrompt(ctx),
    messages,
    tools: { ...buildReadTools(kb), ...buildWriteTools(kb, filesChanged) },
    stopWhen: stepCountIs(MAX_STEPS),
  });
  return { result, filesChanged };
}
