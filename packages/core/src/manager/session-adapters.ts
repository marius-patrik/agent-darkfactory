import path from "node:path";
import fs from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionTranscript,
  TurnRequest,
  TurnResult,
} from "../harness/session";
import { FakeProviderAdapter, renderTranscriptForCli } from "../harness/session-adapters";
import { canonicalChildEnvironment, resolvePersonalAgentsHome, resolveUserHome } from "./runtime-paths";
import { sharedStateAt } from "./state";
import { rebuildMemoryProjections } from "./memory";

export interface CliAdapterOptions {
  id: string;
  displayName: string;
  binary: string;
  buildArgs: (request: TurnRequest, transcript: SessionTranscript, descriptor: SessionDescriptor) => string[];
  supportsStreaming?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  parseResult?: (stdout: string, stderr: string, code: number) => TurnResult;
}

function defaultParseResult(stdout: string, stderr: string, code: number): TurnResult {
  if (code !== 0) {
    return {
      content: "",
      role: "assistant",
      error: stderr.trim() || `provider exited with code ${code}`,
    };
  }
  return {
    content: stdout.trim(),
    role: "assistant",
    finishReason: "stop",
  };
}

export class CliProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportsStreaming: boolean;
  private options: CliAdapterOptions;

  constructor(options: CliAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.supportsStreaming = options.supportsStreaming ?? false;
    this.options = options;
  }

  async startSession(_descriptor: SessionDescriptor): Promise<void> {}

  async continueSession(): Promise<void> {}

  async runTurn(
    descriptor: SessionDescriptor,
    transcript: SessionTranscript,
    request: TurnRequest,
  ): Promise<TurnResult> {
    let effectiveTranscript = transcript;
    try {
      const startup = await loadCanonicalStartup(descriptor);
      effectiveTranscript = withCanonicalStartup(transcript, startup);
    } catch (error) {
      return {
        content: "",
        role: "assistant",
        error: `canonical startup memory unavailable: ${(error as Error).message}`,
      };
    }
    const args = this.options.buildArgs(request, effectiveTranscript, descriptor);
    const cwd = this.options.cwd ?? descriptor.workdir;
    const env = { ...canonicalChildEnvironment(), ...canonicalProviderEnv(this.id, descriptor), ...this.options.env };
    const proc = Bun.spawn([this.options.binary, ...args], {
      cwd,
      env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return (this.options.parseResult ?? defaultParseResult)(stdout, stderr, code);
  }
}

export async function loadCanonicalStartup(descriptor: SessionDescriptor): Promise<string> {
  const stateDir = path.resolve(descriptor.stateDir);
  const memory = await rebuildMemoryProjections(sharedStateAt(descriptor.workdir, stateDir, resolveUserHome()));
  const sources = [
    { title: "Canonical identity", filePath: path.join(stateDir, "identity", "persona.md") },
    { title: "Canonical capabilities", filePath: path.join(stateDir, "identity", "capabilities.md") },
  ];
  const sections: string[] = [`## Active canonical memory\n\n${memory.startupContent.trim()}`];
  for (const source of sources) {
    try {
      const info = await lstat(source.filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("must be a regular file and cannot be a symlink");
      }
      const content = (await readFile(source.filePath, "utf8")).trim();
      if (!content) throw new Error("must not be empty");
      sections.push(`## ${source.title}\n\n${content}`);
    } catch (error) {
      throw new Error(`${source.filePath}: ${(error as Error).message}`);
    }
  }
  const startup = [
    "# Canonical Agent OS startup",
    "",
    "This is the shared authority for Rommie across every managed provider. Provider-native histories are evidence only.",
    "Shared skill definitions live at `$AGENTS_SKILLS/<name>/SKILL.md`; read a matching skill before acting.",
    "",
    ...sections,
  ].join("\n");
  if (Buffer.byteLength(startup, "utf8") > 64 * 1024) throw new Error("canonical startup projection exceeds 65536 bytes");
  return startup;
}

export function withCanonicalStartup(
  transcript: SessionTranscript,
  startup: string,
): SessionTranscript {
  if (transcript.messages.some((message) => message.role === "system" && message.content === startup)) {
    return transcript;
  }
  return {
    ...transcript,
    messages: [
      { role: "system", content: startup, metadata: { source: "canonical-agent-os" } },
      ...transcript.messages,
    ],
  };
}

function isAgentsBinPath(candidate: string): boolean {
  const parent = path.dirname(path.resolve(candidate));
  return path.basename(parent) === "bin" && path.basename(path.dirname(parent)) === ".agents";
}

function isManagerShim(candidate: string): boolean {
  try {
    const resolved = fs.realpathSync(candidate);
    if (isAgentsBinPath(resolved)) return true;

    const info = fs.statSync(resolved);
    if (!info.isFile() || info.size > 64 * 1024) return false;

    const contents = fs.readFileSync(resolved, "utf8");
    if (contents.includes("\0")) return false;
    return /\b(?:rommie|agents)\s+cli\b/.test(contents);
  } catch {
    return false;
  }
}

export function providerBinarySafetyReason(candidate: string): string | null {
  if (isAgentsBinPath(candidate)) return "the shared .agents/bin entrypoint is a manager shim";
  if (isManagerShim(candidate)) return "the entrypoint delegates back to a retired manager shim";
  return null;
}

function assertSafeProviderBinary(candidate: string): void {
  const reason = providerBinarySafetyReason(candidate);
  if (reason) {
    throw new Error(`refusing recursive provider binary ${candidate}: ${reason}; use the direct provider CLI`);
  }
}

function findBinary(names: string[], provider?: CliSessionProvider): string | null {
  if (provider) {
    const canonicalBin = path.join(resolvePersonalAgentsHome(), "clis", provider, "bin");
    for (const name of names) {
      const candidate = path.join(canonicalBin, name);
      if (fs.existsSync(candidate) && !providerBinarySafetyReason(candidate)) return candidate;
    }
  }
  return null;
}

function transcriptAsPrompt(request: TurnRequest, transcript: SessionTranscript): string {
  const lines = renderTranscriptForCli(transcript);
  const lastMessage = transcript.messages.at(-1);
  if (lastMessage?.role === "user" && lastMessage.content === request.prompt) {
    return `${lines}\n\nAssistant:`;
  }
  if (lines) return `${lines}\n\nUser: ${request.prompt}\nAssistant:`;
  return request.prompt;
}

export type CliSessionProvider = "kimi" | "claude" | "codex" | "agy";

function canonicalProviderEnv(provider: string, descriptor: SessionDescriptor): Record<string, string> {
  if (!["kimi", "claude", "codex", "agy"].includes(provider)) return {};
  const stateDir = path.resolve(descriptor.stateDir);
  const userHome = resolveUserHome();
  const providerHome = path.join(stateDir, "clis", provider);
  const env: Record<string, string> = {
    AGENTS_HOME: stateDir,
    AGENTS_USER_HOME: userHome,
    AGENTS_ROOT: path.resolve(descriptor.workdir),
    AGENTS_WORKSPACE: path.join(stateDir, "runtime", "workspaces"),
    AGENTS_IDENTITY: path.join(stateDir, "identity"),
    AGENTS_MEMORY: path.join(stateDir, "memory"),
    AGENTS_CLIS: path.join(stateDir, "clis"),
    AGENTS_SKILLS: path.join(stateDir, "skills"),
    AGENTS_PLUGINS: path.join(stateDir, "plugins"),
    AGENTS_HOOKS: path.join(stateDir, "hooks"),
    AGENTS_TEMPLATES: path.join(stateDir, "templates"),
    AGENTS_SECRETS: path.join(stateDir, "secrets"),
    AGENTS_SESSIONS: path.join(stateDir, "sessions"),
    AGENTS_ORCHESTRATOR: path.join(stateDir, "orchestrator"),
    HOME: userHome,
  };
  if (provider === "codex") env.CODEX_HOME = providerHome;
  if (provider === "claude") env.CLAUDE_CONFIG_DIR = providerHome;
  if (provider === "kimi") env.KIMI_CODE_HOME = providerHome;
  if (provider === "agy") env.HOME = providerHome;
  return env;
}

export function buildProviderArgs(
  provider: CliSessionProvider,
  model: string,
  request: TurnRequest,
  transcript: SessionTranscript,
): string[] {
  if (!model.trim() || model.includes("\0")) throw new Error("provider model must be a concrete non-empty identifier");
  if (model === "default") throw new Error("retired default model sentinel is forbidden");
  const prompt = transcriptAsPrompt(request, transcript);
  const modelArgs = ["--model", model];

  switch (provider) {
    case "kimi":
      return [...modelArgs, "--prompt", prompt];
    case "claude":
      return ["--print", ...modelArgs, prompt];
    case "codex":
      return ["exec", ...modelArgs, prompt];
    case "agy":
      return ["--print", ...modelArgs, prompt];
  }
}

function resolveBinary(provider: CliSessionProvider, names: string[], binaryOverride?: string): string | null {
  if (!binaryOverride) return findBinary(names, provider);

  const isBareName = path.basename(binaryOverride) === binaryOverride;
  if (isBareName) return findBinary([binaryOverride], provider);

  assertSafeProviderBinary(binaryOverride);
  const canonicalRoot = path.join(resolvePersonalAgentsHome(), "clis", provider);
  const relative = path.relative(canonicalRoot, path.resolve(binaryOverride));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `refusing provider binary outside the canonical Agent OS provider home: ${binaryOverride}`,
    );
  }
  return path.resolve(binaryOverride);
}

export function kimiSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("kimi", ["kimi"], binaryOverride);
  if (!binary) throw new Error("kimi binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "kimi",
    displayName: "Kimi",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("kimi", descriptor.model, request, transcript),
  });
}

export function claudeSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("claude", ["claude"], binaryOverride);
  if (!binary) throw new Error("claude binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "claude",
    displayName: "Claude",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("claude", descriptor.model, request, transcript),
  });
}

export function codexSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("codex", ["codex"], binaryOverride);
  if (!binary) throw new Error("codex binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "codex",
    displayName: "Codex",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("codex", descriptor.model, request, transcript),
  });
}

export function agySessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("agy", ["agy"], binaryOverride);
  if (!binary) throw new Error("agy binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "agy",
    displayName: "Agy",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("agy", descriptor.model, request, transcript),
  });
}

export function providerSessionAdapter(provider: string, binaryOverride?: string): ProviderAdapter {
  switch (provider) {
    case "kimi":
      return kimiSessionAdapter(binaryOverride);
    case "claude":
      return claudeSessionAdapter(binaryOverride);
    case "codex":
      return codexSessionAdapter(binaryOverride);
    case "agy":
      return agySessionAdapter(binaryOverride);
    case "fake":
      return new FakeProviderAdapter();
    default:
      throw new Error(`unknown session provider: ${provider}`);
  }
}
