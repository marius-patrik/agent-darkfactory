import type { Readable } from "node:stream";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionMode } from "../../sdk/harness/session";
import {
  readPromptFile,
  readPromptStdin,
  type ModelExecutionRequest,
} from "./model-execution";

const MODEL_RUN_MODES = new Set<SessionMode>(["orchestrator", "default", "chat", "task"]);
const TIER_CONFLICTING_FLAGS = ["provider", "model", "agent", "agent-preset", "tui"] as const;
const TIER_EXECUTION_FLAGS = [
  "model-tier",
  "effort",
  "execution-policy",
  "tool-policy",
  "receipt",
  "prompt-file",
  "prompt-stdin",
  "agent",
  "agent-preset",
] as const;
const TIER_ALLOWED_FLAGS = new Set([
  "model-tier",
  "effort",
  "execution-policy",
  "tool-policy",
  "receipt",
  "prompt-file",
  "prompt-stdin",
  "mode",
]);

export interface ModelExecutionCliInput {
  values: string[];
  flags: Record<string, string | boolean>;
  workdir: string;
  stdin?: Readable;
}

async function physicalExecutionWorkdir(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error("execution workdir must be an absolute physical directory");
  }
  const canonical = await realpath(candidate).catch(() => null);
  const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || !info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error("execution workdir must be an absolute physical directory");
  }
  return canonical;
}

function requiredStringFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`run requires --${name}`);
  return value.trim();
}

function optionalStringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`run --${name} requires a value`);
  return value.trim();
}

/** Keep partial canonical requests from silently falling through to legacy run. */
export function selectsModelExecution(flags: Record<string, string | boolean>): boolean {
  return TIER_EXECUTION_FLAGS.some((name) => flags[name] !== undefined);
}

/**
 * Admit exactly one prompt source. Large or sensitive review material should
 * use --prompt-file or --prompt-stdin so it never appears in the process argv.
 */
export async function modelExecutionRequestFromCli(input: ModelExecutionCliInput): Promise<ModelExecutionRequest> {
  const conflicting = TIER_CONFLICTING_FLAGS.find((name) => input.flags[name] !== undefined);
  if (conflicting) {
    throw new Error(`run --model-tier cannot be combined with --${conflicting}`);
  }
  const unknown = Object.keys(input.flags).find((name) => !TIER_ALLOWED_FLAGS.has(name));
  if (unknown) throw new Error(`run --model-tier does not accept --${unknown}`);
  // Admit the complete control contract before opening or consuming a prompt
  // source. An incomplete invocation must not touch potentially sensitive input.
  const modelTier = requiredStringFlag(input.flags, "model-tier");
  const effort = requiredStringFlag(input.flags, "effort");
  const executionPolicy = requiredStringFlag(input.flags, "execution-policy");
  const toolPolicy = requiredStringFlag(input.flags, "tool-policy");
  const receiptPath = requiredStringFlag(input.flags, "receipt");
  const modeValue = optionalStringFlag(input.flags, "mode") ?? "default";
  if (!MODEL_RUN_MODES.has(modeValue as SessionMode)) throw new Error("run --mode is invalid");

  const promptFile = optionalStringFlag(input.flags, "prompt-file");
  const promptStdin = input.flags["prompt-stdin"] === true;
  if (input.flags["prompt-stdin"] !== undefined && !promptStdin) {
    throw new Error("run --prompt-stdin does not take a value");
  }
  if (input.values.length > 1) {
    throw new Error("run positional prompt must be exactly one value");
  }
  const positional = input.values[0]?.trim() ?? "";
  const sourceCount = Number(Boolean(positional)) + Number(Boolean(promptFile)) + Number(promptStdin);
  if (sourceCount !== 1) {
    throw new Error("run requires exactly one prompt source: positional text, --prompt-file, or --prompt-stdin");
  }
  // The invocation directory, not ANDROMEDA_ROOT, owns provider and receipt
  // authority. Resolve it before opening a prompt source so sessions cannot be
  // rebound to the manager distribution through a lexical path alias.
  const workdir = await physicalExecutionWorkdir(input.workdir);
  let prompt: string;
  let promptSource: ModelExecutionRequest["promptSource"];
  if (promptFile) {
    prompt = await readPromptFile(promptFile);
    promptSource = "file";
  } else if (promptStdin) {
    if (!input.stdin || (input.stdin as Readable & { isTTY?: boolean }).isTTY === true) {
      throw new Error("run --prompt-stdin requires piped input");
    }
    prompt = await readPromptStdin(input.stdin);
    promptSource = "stdin";
  } else {
    prompt = positional;
    promptSource = "positional";
  }

  return {
    modelTier,
    effort,
    executionPolicy,
    toolPolicy,
    receiptPath,
    workdir,
    mode: modeValue as SessionMode,
    prompt,
    promptSource,
  };
}
