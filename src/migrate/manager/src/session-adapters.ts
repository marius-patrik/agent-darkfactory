import path from "node:path";
import fs from "node:fs";
import { lstat, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionTranscript,
  TurnRequest,
  TurnResult,
} from "../../harness/session";
import { FakeProviderAdapter, renderTranscriptForCli } from "../../harness/session-adapters";
import {
  canonicalChildEnvironment,
  overlayChildEnvironment,
  resolvePersonalAgentsHome,
  resolveUserHome,
} from "./runtime-paths";
import { sharedStateAt, type SharedState } from "./state";
import { rebuildMemoryProjections } from "./memory";
import { commandInvocation } from "./process-command";
import { readProviderRegistry, sha256File, verifyProviderRegistration, type ProviderRegistration } from "./provider-registry";
import type { KimiAcpTimeouts } from "./kimi-acp";
import { preflightCodexExecutionPolicy, type NarrowExecutionPolicy } from "./codex-preflight";

export interface CliAdapterOptions {
  id: string;
  displayName: string;
  binary: string;
  buildArgs: (request: TurnRequest, transcript: SessionTranscript, descriptor: SessionDescriptor) => string[];
  /** Optional stdin payload. Used when provider prompt secrecy cannot be preserved through argv. */
  buildStdin?: (request: TurnRequest, transcript: SessionTranscript, descriptor: SessionDescriptor) => string;
  supportsStreaming?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  parseResult?: (stdout: string, stderr: string, code: number) => TurnResult;
  /** Provider-native effective-policy attestation after structured output parsing. */
  resolveExecutionPolicy?: (
    descriptor: SessionDescriptor,
    request: TurnRequest,
    result: TurnResult,
    launch: NativeCliLaunch,
  ) => Promise<"read-only" | "workspace-write">;
  /** Provider-native effective tool-surface attestation after structured output parsing. */
  resolveToolPolicy?: (
    descriptor: SessionDescriptor,
    request: TurnRequest,
    result: TurnResult,
    launch: NativeCliLaunch,
  ) => Promise<"standard" | "none">;
  /**
   * Captures immutable per-run authority before canonical launch preparation.
   * This is the only phase allowed to bind to mutable provider registry state.
   */
  preflight?: (descriptor: SessionDescriptor) => Promise<unknown>;
  /**
   * Registry-independent re-verification of the initial attestation after all
   * launch material is prepared and immediately before the provider is spawned.
   */
  verifyPreSpawn?: (descriptor: SessionDescriptor, attestation: unknown) => Promise<void>;
  /**
   * Resolve and attest provider authority before any model turn begins. This
   * gate is separate from registry preflight because it may consult a
   * provider-native zero-token control plane.
   */
  preworkExecutionPolicy?: (
    descriptor: SessionDescriptor,
    request: TurnRequest,
    env: Record<string, string | undefined>,
  ) => Promise<NarrowExecutionPolicy>;
  /**
   * Fail-closed gate run after the provider process exits and before its
   * output is parsed, returned, or recorded. Receives the exact attestation
   * preflight produced for this run, so verification binds to the pre-launch
   * state instead of trusting whatever the registry contains after exit.
   */
  postflight?: (descriptor: SessionDescriptor, attestation: unknown) => Promise<void>;
  /** Manager-recorded receipt describing the concrete request sent for this launch. */
  receipt?: (
    descriptor: SessionDescriptor,
    request: TurnRequest,
    result: TurnResult,
    launch: NativeCliLaunch,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** Immutable provider-native launch material that actually reached Bun.spawn. */
export interface NativeCliLaunch {
  providerArgs: readonly string[];
  stdinPiped: boolean;
}

function providerExecutionFailure(): TurnResult {
  return {
    content: "",
    role: "assistant",
    error: "provider execution failed",
  };
}

function defaultParseResult(stdout: string, _stderr: string, code: number): TurnResult {
  if (code !== 0) {
    // Provider stderr is untrusted and may contain prompts, paths, or
    // credentials. Canonical session errors retain only this fixed result.
    return providerExecutionFailure();
  }
  return {
    content: stdout.trim(),
    role: "assistant",
    finishReason: "stop",
  };
}

const AGY_DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

function forceAgyAutoUpdateDisabled(env: Record<string, string | undefined>, provider: string): void {
  if (provider !== "agy") return;
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === AGY_DISABLE_AUTO_UPDATE_ENV) delete env[name];
  }
  env[AGY_DISABLE_AUTO_UPDATE_ENV] = "true";
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
    const toolPolicy = request.toolPolicy ?? "standard";
    if (toolPolicy !== "standard" && toolPolicy !== "none") {
      throw new Error("provider tool policy is unsupported");
    }
    // Snapshot the initial authority before canonical processing. S0 is a
    // per-run local — no adapter-global mutable slot — so concurrent turns
    // never share or rebind launch authority.
    const attestationS0 = this.options.preflight ? await this.options.preflight(descriptor) : undefined;
    let effectiveTranscript = transcript;
    if (toolPolicy === "none") {
      assertFreshReadIsolatedTranscript(transcript, request);
    } else {
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
    }
    const args = this.options.buildArgs(request, effectiveTranscript, descriptor);
    const stdinText = this.options.buildStdin?.(request, effectiveTranscript, descriptor);
    const cwd = this.options.cwd ?? descriptor.workdir;
    const env = providerProcessEnvironment(this.id, descriptor, toolPolicy, this.options.env ?? {});
    forceAgyAutoUpdateDisabled(env, this.id);
    const invocation = commandInvocation(this.options.binary, args, env);
    const nativeLaunch: NativeCliLaunch = Object.freeze({
      providerArgs: Object.freeze([...args]),
      stdinPiped: stdinText !== undefined,
    });
    const spawnOptions = {
      cwd,
      env,
      stdin: stdinText === undefined ? ("inherit" as const) : ("pipe" as const),
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };
    if (this.options.verifyPreSpawn) {
      await this.options.verifyPreSpawn(descriptor, attestationS0);
    }
    const preworkExecutionPolicy = this.options.preworkExecutionPolicy
      ? await this.options.preworkExecutionPolicy(descriptor, request, env)
      : undefined;
    const proc = Bun.spawn(invocation, spawnOptions);
    if (stdinText !== undefined && proc.stdin && typeof proc.stdin !== "number") {
      proc.stdin.write(stdinText);
      proc.stdin.end();
    }
    // Once a provider is spawned, process completion and postflight attestation
    // are mandatory. An early stdout/stderr failure must not escape before the
    // process settles or bypass the S0 drift check.
    const [stdoutRead, stderrRead, processExit] = await Promise.allSettled([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Re-verify after exit and before the output is parsed, returned, or
    // recorded: a provider that replaced its own executable during the run is
    // rejected even when it produced successful-looking output.
    if (this.options.postflight) await this.options.postflight(descriptor, attestationS0);
    if (stdoutRead.status === "rejected") throw stdoutRead.reason;
    if (stderrRead.status === "rejected") throw stderrRead.reason;
    if (processExit.status === "rejected") throw processExit.reason;
    const stdout = stdoutRead.value;
    const stderr = stderrRead.value;
    const code = processExit.value;
    const result = (this.options.parseResult ?? defaultParseResult)(stdout, stderr, code);
    if (this.options.resolveExecutionPolicy) {
      result.resolvedExecutionPolicy = await this.options.resolveExecutionPolicy(
        descriptor,
        request,
        result,
        nativeLaunch,
      );
    } else if (preworkExecutionPolicy) {
      result.resolvedExecutionPolicy = preworkExecutionPolicy;
    } else {
      // The requested policy and the arguments assembled by Agent OS are not
      // provider-native proof of the policy that actually governed the turn.
      // Ordinary provider sessions may still return content, but logical-tier
      // execution will block success until the provider can attest this field.
      delete result.resolvedExecutionPolicy;
    }
    if (preworkExecutionPolicy && result.resolvedExecutionPolicy !== preworkExecutionPolicy) {
      throw new Error("provider pre-work and completed-turn execution-policy receipts disagree");
    }
    if (this.options.resolveToolPolicy) {
      result.resolvedToolPolicy = await this.options.resolveToolPolicy(
        descriptor,
        request,
        result,
        nativeLaunch,
      );
    } else {
      delete result.resolvedToolPolicy;
    }
    if (this.options.receipt) {
      result.receipt = await this.options.receipt(descriptor, request, result, nativeLaunch);
    }
    return result;
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

/**
 * A zero-tool turn may contain trusted system instructions plus exactly one
 * current user request. Prior conversation or a previously injected canonical
 * startup could already contain tool-derived personal data, so continuation is
 * refused instead of silently treating it as read-isolated.
 */
export function assertFreshReadIsolatedTranscript(
  transcript: SessionTranscript,
  request: TurnRequest,
): void {
  const current = transcript.messages.at(-1);
  if (current?.role !== "user" || current.content !== request.prompt) {
    throw new Error("zero-tool turn is not aligned with the current request");
  }
  if (
    transcript.messages.slice(0, -1).some((message) =>
      message.role !== "system" || message.metadata?.source === "canonical-agent-os"
    )
  ) {
    throw new Error("zero-tool turn requires a fresh read-isolated session");
  }
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
    const candidates = names.flatMap((name) =>
      process.platform === "win32" ? [`${name}.exe`, `${name}.ps1`, name] : [name],
    );
    for (const name of candidates) {
      const candidate = path.join(canonicalBin, name);
      if (fs.existsSync(candidate) && !providerBinarySafetyReason(candidate)) return candidate;
    }
  }
  return null;
}

export function transcriptAsPrompt(request: TurnRequest, transcript: SessionTranscript): string {
  const lines = renderTranscriptForCli(transcript);
  const lastMessage = transcript.messages.at(-1);
  if (lastMessage?.role === "user" && lastMessage.content === request.prompt) {
    return `${lines}\n\nAssistant:`;
  }
  if (lines) return `${lines}\n\nUser: ${request.prompt}\nAssistant:`;
  return request.prompt;
}

export type CliSessionProvider = "kimi" | "claude" | "codex" | "agy";

const READ_ISOLATED_ENVIRONMENT = new Set([
  "CI",
  "COMSPEC",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

function readIsolatedEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    const folded = name.toUpperCase();
    if (!READ_ISOLATED_ENVIRONMENT.has(folded) && !folded.startsWith("LC_")) continue;
    output[name] = value;
  }
  return output;
}

export function providerProcessEnvironment(
  provider: string,
  descriptor: SessionDescriptor,
  toolPolicy: "standard" | "none",
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  if (toolPolicy === "standard") {
    return overlayChildEnvironment(
      canonicalChildEnvironment(),
      extra,
      canonicalProviderEnv(provider, descriptor, toolPolicy),
    );
  }
  if (toolPolicy !== "none") throw new Error("provider tool policy is unsupported");
  return overlayChildEnvironment(
    readIsolatedEnvironment(canonicalChildEnvironment()),
    readIsolatedEnvironment(extra),
    canonicalProviderEnv(provider, descriptor, toolPolicy),
  );
}

export function canonicalProviderEnv(
  provider: string,
  descriptor: SessionDescriptor,
  toolPolicy: "standard" | "none" = "standard",
): Record<string, string> {
  if (!["kimi", "claude", "codex", "agy"].includes(provider)) return {};
  const stateDir = path.resolve(descriptor.stateDir);
  const userHome = resolveUserHome();
  const providerHome = path.join(stateDir, "clis", provider);
  if (toolPolicy === "none") {
    if (provider === "claude") return { CLAUDE_CONFIG_DIR: providerHome };
    if (provider === "kimi") {
      return {
        KIMI_CODE_HOME: providerHome,
        HOME: providerHome,
        USERPROFILE: providerHome,
      };
    }
    throw new Error(`${provider} zero-tool execution is unsupported`);
  }
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
  if (provider === "kimi") {
    // Bind the documented Kimi root and both platform fallback homes. This
    // prevents a managed launch from recreating standalone ~/.kimi-code state
    // when a provider version ignores or temporarily falls back from its
    // provider-specific variable.
    env.KIMI_CODE_HOME = providerHome;
    env.HOME = providerHome;
    env.USERPROFILE = providerHome;
  }
  if (provider === "agy") {
    // Agy (antigravity-cli) resolves its config root ("GeminiDir") from the OS
    // user profile and ignores HOME on Windows, which previously escaped to the
    // forbidden standalone ~/.gemini. Bind the explicit absolute canonical
    // config root and isolate both home variables into the provider home so no
    // resolution path can fall back to the user-profile .gemini directory.
    env.GEMINI_DIR = path.join(providerHome, ".gemini");
    env.HOME = providerHome;
    env.USERPROFILE = providerHome;
  }
  return env;
}

export interface AgyModelResolution {
  requestedModel: string;
  concreteModel: string;
  effort: "low" | "medium" | "high" | null;
}

/** The authenticated Agy Flash model for each provider-native effort setting. */
const AGY_EFFORT_MODELS: Record<"low" | "medium" | "high", string> = {
  low: "Gemini 3.5 Flash (Low)",
  medium: "Gemini 3.5 Flash (Medium)",
  high: "Gemini 3.5 Flash (High)",
};

/**
 * Resolve a requested Agy model to the concrete display-name model Agy expects.
 * Agy carries the reasoning tier inside the model string ("... (Low)") and has
 * no separate effort flag, so canonical effort selects a concrete model
 * variant without changing the Agy provider route. An explicit display name
 * keeps its model family while changing only the provider-native effort
 * suffix; identifiers without a native effort capability fail closed when an
 * independent effort is requested.
 */
export function resolveAgyModel(
  requestedModel: string,
  requestedEffort?: "low" | "medium" | "high",
): AgyModelResolution {
  const requested = requestedModel.trim();
  const tier = requested.toLowerCase();
  if (tier === "low" || tier === "medium" || tier === "high") {
    const effort = requestedEffort ?? tier;
    return { requestedModel, concreteModel: AGY_EFFORT_MODELS[effort], effort };
  }
  const display = requested.match(/^(.*?)\s*\((low|medium|high)\)$/i);
  if (display) {
    const embeddedEffort = display[2]!.toLowerCase() as Exclude<AgyModelResolution["effort"], null>;
    const effort = requestedEffort ?? embeddedEffort;
    const label = `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
    return { requestedModel, concreteModel: `${display[1]!.trim()} (${label})`, effort };
  }
  if (requestedEffort) {
    throw new Error("Agy configured model does not expose a provider-native effort capability");
  }
  return { requestedModel, concreteModel: requested, effort: null };
}

export interface NativeInvocationAttestation {
  executionPolicy: "read-only" | "workspace-write";
  toolPolicy: "standard" | "none";
  model: string;
  effort: "low" | "medium" | "high" | null;
}

/** Reconstruct only Agy's attestable read-only model and effort from exact spawned argv. */
export function attestAgyNativeInvocation(launch: NativeCliLaunch): NativeInvocationAttestation {
  const args = launch.providerArgs;
  if (args[0] === "--sandbox" && args[1] === "--mode" && args[2] === "accept-edits") {
    throw new Error("Agy workspace-write cannot be attested from provider argv alone");
  }
  if (
    launch.stdinPiped ||
    args.length !== 7 ||
    args[0] !== "--sandbox" ||
    args[1] !== "--mode" ||
    args[2] !== "plan" ||
    args[3] !== "--model" ||
    typeof args[4] !== "string" ||
    !args[4]!.trim() ||
    args[4]!.includes("\0") ||
    args[5] !== "--print" ||
    typeof args[6] !== "string" ||
    !args[6]!.trim()
  ) {
    throw new Error("Agy native invocation receipt is malformed");
  }
  const resolution = resolveAgyModel(args[4]!);
  return {
    executionPolicy: "read-only",
    toolPolicy: "standard",
    model: resolution.concreteModel,
    effort: resolution.effort,
  };
}

/** Reconstruct Claude read-only authority exclusively from its exact native flags and stdin transport. */
export function attestClaudeNativeInvocation(launch: NativeCliLaunch): NativeInvocationAttestation {
  const args = launch.providerArgs;
  if (!launch.stdinPiped || args[0] !== "--print" || args[1] !== "--model") {
    throw new Error("Claude native invocation receipt is malformed");
  }
  const model = args[2];
  if (typeof model !== "string" || !model.trim() || model.includes("\0")) {
    throw new Error("Claude native invocation receipt is malformed");
  }
  let cursor = 3;
  let effort: NativeInvocationAttestation["effort"] = null;
  if (args[cursor] === "--effort") {
    const candidate = args[cursor + 1];
    if (candidate !== "low" && candidate !== "medium" && candidate !== "high") {
      throw new Error("Claude native invocation receipt is malformed");
    }
    effort = candidate;
    cursor += 2;
  }
  if (
    args[cursor] !== "--permission-mode" ||
    args[cursor + 1] !== "plan" ||
    args[cursor + 2] !== "--tools" ||
    (args[cursor + 3] !== "Read,Glob,Grep" && args[cursor + 3] !== "") ||
    args[cursor + 4] !== "--no-session-persistence" ||
    args[cursor + 5] !== "--output-format" ||
    args[cursor + 6] !== "json" ||
    args.length !== cursor + 7
  ) {
    throw new Error("Claude native invocation receipt is malformed");
  }
  return {
    executionPolicy: "read-only",
    toolPolicy: args[cursor + 3] === "" ? "none" : "standard",
    model,
    effort,
  };
}

export function buildProviderArgs(
  provider: CliSessionProvider,
  model: string,
  request: TurnRequest,
  transcript: SessionTranscript,
): string[] {
  if (!model.trim() || model.includes("\0")) throw new Error("provider model must be a concrete non-empty identifier");
  if (model === "default") throw new Error("retired default model sentinel is forbidden");
  const executionPolicy = request.executionPolicy ?? "read-only";
  if (executionPolicy !== "read-only" && executionPolicy !== "workspace-write") {
    throw new Error("provider execution policy is unsupported");
  }
  const effortArgs = request.effort ? ["--effort", request.effort] : [];
  const toolPolicy = request.toolPolicy ?? "standard";
  if (toolPolicy !== "standard" && toolPolicy !== "none") {
    throw new Error("provider tool policy is unsupported");
  }
  if (provider === "kimi") return ["acp"];
  const prompt = transcriptAsPrompt(request, transcript);
  const modelArgs = ["--model", model];

  switch (provider) {
    case "claude": {
      if (executionPolicy === "workspace-write") {
        throw new Error("Claude workspace-write is unsupported without a manager-owned physical containment boundary");
      }
      return [
        "--print",
        ...modelArgs,
        ...effortArgs,
        "--permission-mode",
        "plan",
        "--tools",
        toolPolicy === "none" ? "" : "Read,Glob,Grep",
        "--no-session-persistence",
        "--output-format",
        "json",
      ];
    }
    case "codex": {
      if (toolPolicy === "none") {
        throw new Error("Codex zero-tool execution is unsupported without a native complete tool-surface boundary");
      }
      const codexConfig = [
        ...(request.effort ? [`model_reasoning_effort=\"${request.effort}\"`] : []),
        ...(executionPolicy === "workspace-write"
          ? [
              "sandbox_workspace_write.network_access=false",
              "sandbox_workspace_write.exclude_tmpdir_env_var=true",
              "sandbox_workspace_write.exclude_slash_tmp=true",
              "sandbox_workspace_write.writable_roots=[]",
            ]
          : []),
      ];
      return [
        "--ask-for-approval",
        "never",
        "exec",
        "--sandbox",
        executionPolicy,
        ...codexConfig.flatMap((value) => ["--config", value]),
        "--ignore-user-config",
        "--strict-config",
        ...modelArgs,
        "--json",
        "-",
      ];
    }
    case "agy": {
      if (toolPolicy === "none") {
        throw new Error("Agy zero-tool execution is unsupported without provider-native tool-surface evidence");
      }
      if (executionPolicy === "workspace-write") {
        throw new Error("Agy workspace-write is unsupported without provider-native physical authority evidence");
      }
      // Agy's --print consumes the immediately-following argv token as the
      // prompt, so any flag placed after it is swallowed as user input and the
      // model silently falls back to the default. Bind "--model <concrete>"
      // first and place "--print <prompt>" last so the exact prompt and the
      // requested model both apply.
      const { concreteModel } = resolveAgyModel(model, request.effort);
      return [
        "--sandbox",
        "--mode",
        "plan",
        "--model",
        concreteModel,
        "--print",
        prompt,
      ];
    }
  }
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

export function parseCodexJsonResult(stdout: string, stderr: string, code: number): TurnResult {
  if (code !== 0) return defaultParseResult("", stderr, code);
  let content = "";
  let usage: TurnResult["usage"];
  let providerThreadId: string | null = null;
  try {
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started") {
        if (
          providerThreadId !== null ||
          typeof event.thread_id !== "string" ||
          !/^[A-Za-z0-9-]{1,128}$/.test(event.thread_id)
        ) {
          throw new Error("malformed thread identity");
        }
        providerThreadId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") content += item.text;
      }
      if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
        const raw = event.usage as Record<string, unknown>;
        const tokensIn = safeNonNegativeInteger(raw.input_tokens);
        const tokensOut = safeNonNegativeInteger(raw.output_tokens);
        if (tokensIn === undefined || tokensOut === undefined) throw new Error("malformed usage");
        usage = { tokensIn, tokensOut, totalTokens: tokensIn + tokensOut };
      }
    }
  } catch {
    return { content: "", role: "assistant", error: "provider returned malformed structured output" };
  }
  if (!providerThreadId || !content || !usage) {
    return { content: "", role: "assistant", error: "provider returned malformed structured output" };
  }
  return {
    content,
    role: "assistant",
    usage,
    finishReason: "stop",
    receipt: { providerThreadId },
  };
}

const MAX_CODEX_ROLLOUT_BYTES = 64 * 1024 * 1024;

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function candidateCodexDateDirectories(sessionsRoot: string): string[] {
  const output: string[] = [];
  const now = new Date();
  for (const offset of [-1, 0, 1]) {
    const date = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    output.push(
      path.join(
        sessionsRoot,
        String(date.getUTCFullYear()).padStart(4, "0"),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
      ),
    );
  }
  return output;
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function codexPermissionPath(value: unknown): { kind: "root" } | { kind: "path"; path: string } | null {
  if (!exactRecord(value)) return null;
  if (value.type === "special" && exactKeys(value, ["type", "value"]) && exactRecord(value.value)) {
    return exactKeys(value.value, ["kind"]) && value.value.kind === "root" ? { kind: "root" } : null;
  }
  if (value.type === "path" && exactKeys(value, ["path", "type"]) && typeof value.path === "string") {
    return { kind: "path", path: value.path };
  }
  return null;
}

/** Verify completed Codex network and writable-root authority from its native permission profile. */
function attestCodexPermissionProfile(
  value: unknown,
  requested: "read-only" | "workspace-write",
  workdir: string,
): boolean {
  if (
    !exactRecord(value) ||
    !exactKeys(value, ["file_system", "network", "type"]) ||
    value.type !== "managed" ||
    value.network !== "restricted" ||
    !exactRecord(value.file_system) ||
    !exactKeys(value.file_system, ["entries", "type"]) ||
    value.file_system.type !== "restricted" ||
    !Array.isArray(value.file_system.entries)
  ) {
    return false;
  }
  let rootRead = 0;
  const writablePaths: string[] = [];
  for (const entry of value.file_system.entries) {
    if (
      !exactRecord(entry) ||
      !exactKeys(entry, ["access", "path"]) ||
      (entry.access !== "read" && entry.access !== "write")
    ) {
      return false;
    }
    const permissionPath = codexPermissionPath(entry.path);
    if (!permissionPath) return false;
    if (entry.access === "read") {
      if (permissionPath.kind === "root") rootRead += 1;
      continue;
    }
    if (permissionPath.kind !== "path") return false;
    writablePaths.push(permissionPath.path);
  }
  if (rootRead !== 1) return false;
  return requested === "read-only"
    ? writablePaths.length === 0
    : writablePaths.length === 1 && samePath(writablePaths[0]!, workdir);
}

/**
 * Admit the exact Codex native rollout and verify the provider's effective
 * turn context. This closes the #257 gap where workspace-write argv previously
 * resolved to a read-only managed sandbox.
 */
export async function attestCodexExecutionPolicy(
  descriptor: SessionDescriptor,
  request: TurnRequest,
  providerThreadId: string,
): Promise<"read-only" | "workspace-write"> {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(providerThreadId)) {
    throw new Error("Codex native execution receipt is malformed");
  }
  const requested = request.executionPolicy ?? "read-only";
  if (requested !== "read-only" && requested !== "workspace-write") {
    throw new Error("Codex execution policy is unsupported");
  }
  const providerHome = path.join(path.resolve(descriptor.stateDir), "clis", "codex");
  const sessionsRoot = path.join(providerHome, "sessions");
  const candidates: string[] = [];
  for (const directory of candidateCodexDateDirectories(sessionsRoot)) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.length > 512) throw new Error("Codex native execution receipt inventory is ambiguous");
    for (const entry of entries) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.name.endsWith(`-${providerThreadId}.jsonl`)
      ) {
        candidates.push(path.join(directory, entry.name));
      }
    }
  }
  if (candidates.length !== 1) throw new Error("Codex native execution receipt is unavailable or ambiguous");
  const rolloutPath = candidates[0]!;
  const [physicalHome, physicalRollout] = await Promise.all([
    realpath(providerHome).catch(() => null),
    realpath(rolloutPath).catch(() => null),
  ]);
  if (!physicalHome || !physicalRollout) throw new Error("Codex native execution receipt is unavailable or ambiguous");
  const relative = path.relative(physicalHome, physicalRollout);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Codex native execution receipt escaped canonical provider state");
  }
  const named = await lstat(rolloutPath, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.size <= 0n || named.size > BigInt(MAX_CODEX_ROLLOUT_BYTES)) {
    throw new Error("Codex native execution receipt is malformed");
  }
  const handle = await open(rolloutPath, "r");
  let raw: string;
  try {
    const before = await handle.stat({ bigint: true });
    raw = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const finalNamed = await lstat(rolloutPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.dev !== finalNamed.dev ||
      after.ino !== finalNamed.ino ||
      after.size !== finalNamed.size ||
      after.mtimeNs !== finalNamed.mtimeNs
    ) {
      throw new Error("Codex native execution receipt changed during admission");
    }
  } finally {
    await handle.close();
  }
  let sessionMeta: Record<string, unknown> | null = null;
  let turnContext: Record<string, unknown> | null = null;
  try {
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      if (line.length > 16 * 1024 * 1024) throw new Error("oversized rollout entry");
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "session_meta") {
        if (sessionMeta || !exactRecord(event.payload)) throw new Error("ambiguous session metadata");
        sessionMeta = event.payload;
      }
      if (event.type === "turn_context") {
        if (turnContext || !exactRecord(event.payload)) throw new Error("ambiguous turn context");
        turnContext = event.payload;
      }
    }
  } catch {
    throw new Error("Codex native execution receipt is malformed");
  }
  if (!sessionMeta || !turnContext) throw new Error("Codex native execution receipt is incomplete");
  if (
    sessionMeta.id !== providerThreadId ||
    sessionMeta.session_id !== providerThreadId ||
    sessionMeta.source !== "exec" ||
    !samePath(String(sessionMeta.cwd ?? ""), descriptor.workdir)
  ) {
    throw new Error("Codex native execution receipt identity does not match the canonical turn");
  }
  const sandboxPolicy = exactRecord(turnContext.sandbox_policy) ? turnContext.sandbox_policy : null;
  const roots = Array.isArray(turnContext.workspace_roots) ? turnContext.workspace_roots : [];
  if (
    !samePath(String(turnContext.cwd ?? ""), descriptor.workdir) ||
    roots.length !== 1 ||
    typeof roots[0] !== "string" ||
    !samePath(roots[0], descriptor.workdir) ||
    turnContext.model !== descriptor.model ||
    turnContext.approval_policy !== "never"
  ) {
    throw new Error("Codex native execution receipt does not match the canonical request");
  }
  if (request.effort && turnContext.effort !== request.effort) {
    throw new Error("Codex native execution receipt does not match the requested effort");
  }
  if (!attestCodexPermissionProfile(turnContext.permission_profile, requested, descriptor.workdir)) {
    throw new Error("Codex resolved execution policy does not match the requested policy");
  }
  if (!sandboxPolicy || sandboxPolicy.type !== requested) {
    throw new Error("Codex resolved execution policy does not match the requested policy");
  }
  const policyKeys = Object.keys(sandboxPolicy).sort();
  if (requested === "read-only") {
    // Codex serializes read-only as a closed native enum variant. Its exact
    // one-key shape is the completed-turn proof that neither a network toggle
    // nor any writable-root extension was admitted; accepting extra authority
    // fields would make this variant ambiguous.
    if (policyKeys.length !== 1 || policyKeys[0] !== "type") {
      throw new Error("Codex resolved execution policy does not match the requested policy");
    }
    return requested;
  }
  const writableRoots = sandboxPolicy.writable_roots;
  const expectedWorkspaceKeys = [
    "exclude_slash_tmp",
    "exclude_tmpdir_env_var",
    "network_access",
    "type",
    "writable_roots",
  ];
  if (
    policyKeys.length !== expectedWorkspaceKeys.length ||
    policyKeys.some((key, index) => key !== expectedWorkspaceKeys[index]) ||
    sandboxPolicy.network_access !== false ||
    sandboxPolicy.exclude_tmpdir_env_var !== true ||
    sandboxPolicy.exclude_slash_tmp !== true ||
    !Array.isArray(writableRoots) ||
    writableRoots.length !== 0
  ) {
    throw new Error("Codex resolved execution policy does not match the requested policy");
  }
  return requested;
}

export function parseClaudeJsonResult(stdout: string, stderr: string, code: number): TurnResult {
  if (code !== 0) return defaultParseResult("", stderr, code);
  try {
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof payload.result !== "string") throw new Error("missing result");
    const rawUsage = payload.usage;
    let usage: TurnResult["usage"];
    if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
      const raw = rawUsage as Record<string, unknown>;
      const tokensIn = safeNonNegativeInteger(raw.input_tokens);
      const tokensOut = safeNonNegativeInteger(raw.output_tokens);
      if (tokensIn === undefined || tokensOut === undefined) throw new Error("malformed usage");
      usage = { tokensIn, tokensOut, totalTokens: tokensIn + tokensOut };
    }
    return { content: payload.result, role: "assistant", usage, finishReason: "stop" };
  } catch {
    return { content: "", role: "assistant", error: "provider returned malformed structured output" };
  }
}

class KimiAcpProviderAdapter implements ProviderAdapter {
  readonly id = "kimi";
  readonly displayName = "Kimi";
  readonly supportsStreaming = false;

  constructor(
    private readonly binary: string,
    private readonly timeouts?: Partial<KimiAcpTimeouts>,
  ) {}

  async startSession(_descriptor: SessionDescriptor): Promise<void> {}

  async continueSession(_descriptor: SessionDescriptor, _transcript: SessionTranscript): Promise<void> {}

  async runTurn(
    descriptor: SessionDescriptor,
    transcript: SessionTranscript,
    request: TurnRequest,
  ): Promise<TurnResult> {
    const toolPolicy = request.toolPolicy ?? "standard";
    if (toolPolicy !== "standard" && toolPolicy !== "none") {
      throw new Error("provider tool policy is unsupported");
    }
    let startup = "";
    if (toolPolicy === "none") {
      assertFreshReadIsolatedTranscript(transcript, request);
    } else {
      try {
        startup = await loadCanonicalStartup(descriptor);
      } catch (error) {
        return {
          content: "",
          role: "assistant",
          error: `canonical startup memory unavailable: ${(error as Error).message}`,
        };
      }
    }
    const env = providerProcessEnvironment("kimi", descriptor, toolPolicy);
    // Keep the provider-specific ACP/Zod boundary off unrelated manager
    // startup paths; a managed Kimi turn loads it only after canonical startup
    // and provider environment preparation have succeeded.
    const { runKimiAcpTurn } = await import("./kimi-acp");
    return runKimiAcpTurn({
      binary: this.binary,
      descriptor,
      transcript,
      request,
      startup,
      env,
      timeouts: this.timeouts,
    });
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

export function kimiSessionAdapter(
  binaryOverride?: string,
  timeouts?: Partial<KimiAcpTimeouts>,
): ProviderAdapter {
  const binary = resolveBinary("kimi", ["kimi"], binaryOverride);
  if (!binary) throw new Error("kimi binary not found in the canonical Agent OS provider home");
  return new KimiAcpProviderAdapter(binary, timeouts);
}

export function claudeSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("claude", ["claude"], binaryOverride);
  if (!binary) throw new Error("claude binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "claude",
    displayName: "Claude",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("claude", descriptor.model, request, transcript),
    buildStdin: (request, transcript) => transcriptAsPrompt(request, transcript),
    parseResult: parseClaudeJsonResult,
    resolveExecutionPolicy: async (_descriptor, _request, _result, launch) =>
      attestClaudeNativeInvocation(launch).executionPolicy,
    resolveToolPolicy: async (_descriptor, _request, _result, launch) =>
      attestClaudeNativeInvocation(launch).toolPolicy,
    receipt: (_descriptor, request, result, launch) => {
      const native = attestClaudeNativeInvocation(launch);
      return {
        provider: "claude",
        model: native.model,
        effort: native.effort,
        agentPreset: request.agentPreset ?? null,
        requestedExecutionPolicy: request.executionPolicy ?? "read-only",
        resolvedExecutionPolicy: result.resolvedExecutionPolicy ?? null,
        requestedToolPolicy: request.toolPolicy ?? "standard",
        resolvedToolPolicy: result.resolvedToolPolicy ?? null,
      };
    },
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
    buildStdin: (request, transcript) => transcriptAsPrompt(request, transcript),
    parseResult: parseCodexJsonResult,
    preworkExecutionPolicy: (descriptor, request, env) =>
      preflightCodexExecutionPolicy(binary, descriptor, request, env),
    resolveExecutionPolicy: async (descriptor, request, result, _launch) => {
      const providerThreadId = exactRecord(result.receipt) ? result.receipt.providerThreadId : null;
      if (typeof providerThreadId !== "string") throw new Error("Codex native execution receipt is missing");
      return attestCodexExecutionPolicy(descriptor, request, providerThreadId);
    },
    resolveToolPolicy: async (_descriptor, request) => {
      if ((request.toolPolicy ?? "standard") !== "standard") {
        throw new Error("Codex zero-tool execution is unsupported without a native complete tool-surface boundary");
      }
      return "standard";
    },
    receipt: (descriptor, request, result) => ({
      provider: "codex",
      model: descriptor.model,
      effort: request.effort ?? null,
      agentPreset: request.agentPreset ?? null,
      requestedExecutionPolicy: request.executionPolicy ?? "read-only",
      resolvedExecutionPolicy: result.resolvedExecutionPolicy ?? null,
      requestedToolPolicy: request.toolPolicy ?? "standard",
      resolvedToolPolicy: result.resolvedToolPolicy ?? null,
    }),
  });
}

/**
 * Immutable per-run authority S0 captured before canonical launch preparation.
 * Immediate pre-spawn and post-exit verification both bind to this snapshot and
 * never reread or follow later mutable provider registry state.
 */
interface AgyLaunchAttestation {
  /** Configured launch path as spawned (pre-realpath). */
  configuredExecutable: string;
  /** Preflight realpath of the configured executable (== pinned registration target). */
  resolvedExecutable: string;
  /** Verified pinned digest captured before launch. */
  sha256: string;
  /** Canonical physical boundary paths, each equal to its own realpath at preflight. */
  clisDir: string;
  providerHome: string;
  binDir: string;
  configDir: string;
  authFile: string;
}

/** The canonical physical Agy boundary: clis, provider home, bin, config root, credential. */
interface AgyPhysicalBoundary {
  clisDir: string;
  providerHome: string;
  binDir: string;
  configDir: string;
  authFile: string;
}

type AgyVerificationPhase = "before launch" | "immediately before launch" | "after the managed run";

/**
 * Computes the canonical Agy boundary paths from the physical state root.
 * The state directory is realpath-resolved first so casing and platform link
 * quirks (e.g. /var -> /private/var) cannot alias the canonical paths.
 */
function agyPhysicalBoundaryPaths(stateDirReal: string): AgyPhysicalBoundary {
  const clisDir = path.join(stateDirReal, "clis");
  const providerHome = path.join(clisDir, "agy");
  const binDir = path.join(providerHome, "bin");
  const configDir = path.join(providerHome, ".gemini");
  return { clisDir, providerHome, binDir, configDir, authFile: path.join(configDir, "oauth_creds.json") };
}

/**
 * Verifies the canonical Agy boundary is physical and contained: every
 * component must exist at its exact canonical location — realpath equality
 * rejects symlinks, junctions, and reparse-point escapes — and the credential
 * must be a readable regular file (a directory masquerading as the credential
 * is refused). The provider bin directory is verified as a physical directory
 * so a junction/symlink escape cannot redirect the executable search path.
 * Readability is proven by opening and immediately closing the file; contents
 * are never read, copied, or logged. The same check runs for initial authority
 * capture, immediately before launch, and after the managed run against the
 * attested paths, so preparation-time and mid-run boundary swaps are refused
 * with an actionable, secret-safe diagnostic.
 */
async function assertAgyPhysicalBoundary(
  boundary: AgyPhysicalBoundary,
  phase: AgyVerificationPhase,
): Promise<void> {
  const entries = [
    {
      label: "canonical clis directory",
      path: boundary.clisDir,
      directory: true,
      missing: `agy canonical clis directory is missing ${phase}: ${boundary.clisDir}; restore the canonical Agent OS home`,
    },
    {
      label: "canonical provider home",
      path: boundary.providerHome,
      directory: true,
      missing: `agy canonical provider home is missing ${phase}: ${boundary.providerHome}; restore the canonical provider home under clis/agy`,
    },
    {
      label: "canonical provider bin directory",
      path: boundary.binDir,
      directory: true,
      missing: `agy canonical provider bin directory is missing ${phase}: ${boundary.binDir}; restore the canonical provider home under clis/agy`,
    },
    {
      label: "canonical config root (.gemini)",
      path: boundary.configDir,
      directory: true,
      missing: `agy canonical config root (.gemini) is missing ${phase}, so canonical authentication is missing: ${boundary.configDir}; restore the canonical provider home under clis/agy`,
    },
    {
      label: "canonical auth (clis/agy/.gemini/oauth_creds.json)",
      path: boundary.authFile,
      directory: false,
      missing: `agy canonical authentication is missing ${phase} (clis/agy/.gemini/oauth_creds.json); refusing to launch without canonical auth`,
    },
  ];
  for (const entry of entries) {
    let info;
    try {
      info = await lstat(entry.path);
    } catch {
      throw new Error(entry.missing);
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `agy ${entry.label} must not be a symlink or junction ${phase}: ${entry.path}; the canonical boundary must be physical`,
      );
    }
    if (entry.directory && !info.isDirectory()) {
      throw new Error(`agy ${entry.label} is not a directory ${phase}: ${entry.path}`);
    }
    if (!entry.directory && !info.isFile()) {
      throw new Error(
        `agy canonical auth is not a regular file ${phase} (clis/agy/.gemini/oauth_creds.json); a directory or special file masquerading as the credential is refused`,
      );
    }
    let resolved: string;
    try {
      resolved = await realpath(entry.path);
    } catch {
      throw new Error(`agy ${entry.label} cannot be resolved ${phase}: ${entry.path}`);
    }
    if (resolved !== entry.path) {
      throw new Error(
        `agy ${entry.label} resolves outside its canonical location ${phase} (${entry.path}); symlinks, junctions, and reparse-point escapes are refused`,
      );
    }
  }
  // Prove readability without reading: open the credential and close it
  // immediately; contents are never read, copied, or logged.
  let handle: FileHandle | undefined;
  try {
    handle = await open(boundary.authFile, "r");
  } catch {
    throw new Error(
      `agy canonical authentication is not readable ${phase} (clis/agy/.gemini/oauth_creds.json); refusing to launch without readable canonical auth`,
    );
  } finally {
    if (handle) await handle.close();
  }
}

/**
 * Verifies the configured launch executable is a regular non-link file whose
 * realpath is contained within the attested physical provider bin directory
 * and matches the pinned resolved executable. Safe OS-level ancestor aliases
 * (e.g. /var -> /private/var or a Windows junctioned parent) are permitted:
 * the configured path may differ textually from its realpath as long as it
 * resolves to the immutable pinned executable. This rejects in-bin executable
 * symlink escapes and reparse-point aliases that realpath-based checks alone
 * would follow. The same check runs for initial authority capture, immediately
 * before launch, and after the managed run against the attested configured path.
 */
async function assertAgyLaunchExecutable(
  configuredExecutable: string,
  resolvedExecutable: string,
  boundary: AgyPhysicalBoundary,
  phase: AgyVerificationPhase,
): Promise<void> {
  let info;
  try {
    info = await lstat(configuredExecutable);
  } catch {
    throw new Error(`agy launch binary is missing ${phase}: ${configuredExecutable}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `agy launch binary must not be a symlink or junction ${phase}: ${configuredExecutable}; the canonical boundary must be physical`,
    );
  }
  if (!info.isFile()) {
    throw new Error(`agy launch binary is not a regular file ${phase}: ${configuredExecutable}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(configuredExecutable);
  } catch {
    throw new Error(`agy launch binary cannot be resolved ${phase}: ${configuredExecutable}`);
  }
  if (resolved !== resolvedExecutable) {
    throw new Error(
      `agy launch binary ${configuredExecutable} is not the pinned executable ${resolvedExecutable} ${phase}; re-pin through \`agents cli pin agy\``,
    );
  }
  const relative = path.relative(boundary.binDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `agy launch binary is outside the canonical provider bin directory ${phase}: ${configuredExecutable}`,
    );
  }
}

/**
 * Verifies the managed Agy launch binary against its canonical pinned
 * registration before launch and returns the registration plus the launch
 * realpath. Binary upgrades happen only through the trusted Agent OS
 * pin/upgrade control plane, so any checksum drift means the executable
 * changed behind the pin (replaced or self-updated) and the launch is refused
 * with a durable, non-secret repair diagnostic. Never reads or copies another
 * provider's credentials.
 */
async function assertAgyPinnedExecutable(
  state: SharedState,
  binary: string,
): Promise<{ registration: ProviderRegistration; resolvedLaunch: string }> {
  const registry = await readProviderRegistry(state);
  const registration = registry.providers.agy;
  if (!registration) {
    throw new Error("agy executable is not pinned in the canonical registry before launch; repair with `agents cli pin agy`");
  }
  const verification = await verifyProviderRegistration(registration);
  if (!verification.ok) {
    throw new Error(
      `agy pinned executable drift detected before launch (${verification.issues.join(
        "; ",
      )}); the executable changed behind the pin, so the run is refused; re-pin only through the trusted Agent OS upgrade path with \`agents cli pin agy\``,
    );
  }
  let resolvedLaunch: string;
  try {
    resolvedLaunch = await realpath(binary);
  } catch {
    throw new Error(`agy launch binary is missing before launch: ${binary}`);
  }
  if (resolvedLaunch !== registration.resolvedExecutable) {
    throw new Error(
      `agy launch binary ${binary} is not the pinned executable ${registration.executable} before launch; re-pin through \`agents cli pin agy\``,
    );
  }
  return { registration, resolvedLaunch };
}

/**
 * Captures the initial fail-closed authority S0 before canonical launch
 * preparation. This is the only phase that reads the mutable provider registry.
 * It refuses an invalid initial pin, unsafe physical boundary, executable escape,
 * or missing/unreadable canonical authentication and returns the immutable S0
 * used by both immediate pre-spawn and post-exit verification. Never reads or
 * copies another provider's credentials.
 */
async function agyPreflight(descriptor: SessionDescriptor, binary: string): Promise<AgyLaunchAttestation> {
  const state = sharedStateAt(descriptor.workdir, path.resolve(descriptor.stateDir), resolveUserHome());
  const { registration, resolvedLaunch } = await assertAgyPinnedExecutable(state, binary);
  let stateDirReal: string;
  try {
    stateDirReal = await realpath(state.stateDir);
  } catch {
    throw new Error(`agy canonical state directory is missing before launch: ${state.stateDir}`);
  }
  const boundary = agyPhysicalBoundaryPaths(stateDirReal);
  await assertAgyPhysicalBoundary(boundary, "before launch");
  await assertAgyLaunchExecutable(binary, resolvedLaunch, boundary, "before launch");
  return Object.freeze({
    configuredExecutable: binary,
    resolvedExecutable: resolvedLaunch,
    sha256: registration.sha256,
    ...boundary,
  });
}

/**
 * Registry-independent verification against immutable authority S0. Runs after
 * launch materialization immediately before spawn and again after process exit.
 * It never rereads providers.json, so a later registry+binary rewrite cannot
 * bless a replacement. The slower physical-boundary checks run first; the
 * executable path and checksum verification deliberately finishes the gate so
 * no other awaited filesystem operation reopens a mutation interval before
 * spawn. Credential contents are never read, copied, or logged.
 */
async function verifyAgyAttestedState(
  attestation: AgyLaunchAttestation | undefined,
  phase: Exclude<AgyVerificationPhase, "before launch">,
): Promise<void> {
  if (!attestation) {
    throw new Error(`agy ${phase} verification is missing its immutable initial attestation; refusing`);
  }
  // S0-only: no mutable registry or replacement authority is used. Check the
  // canonical boundary first, then make the executable realpath and byte
  // attestation the final awaited filesystem work before spawn.
  await assertAgyPhysicalBoundary(attestation, phase);
  await assertAgyLaunchExecutable(
    attestation.configuredExecutable,
    attestation.resolvedExecutable,
    attestation,
    phase,
  );
  let digest: string;
  try {
    digest = await sha256File(attestation.resolvedExecutable);
  } catch {
    throw new Error(`agy pinned executable is missing ${phase}: ${attestation.resolvedExecutable}`);
  }
  if (digest !== attestation.sha256) {
    throw new Error(
      `agy pinned executable drift detected ${phase} (attested executable checksum changed); the executable no longer matches immutable initial authority, so ${phase === "immediately before launch" ? "launch" : "the result"} is refused; re-pin only through the trusted Agent OS upgrade path with \`agents cli pin agy\``,
    );
  }
}

export function agySessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = resolveBinary("agy", ["agy"], binaryOverride);
  if (!binary) throw new Error("agy binary not found in the canonical Agent OS provider home");
  return new CliProviderAdapter({
    id: "agy",
    displayName: "Agy",
    binary,
    buildArgs: (request, transcript, descriptor) => buildProviderArgs("agy", descriptor.model, request, transcript),
    preflight: (descriptor) => agyPreflight(descriptor, binary),
    verifyPreSpawn: (_descriptor, attestation) =>
      verifyAgyAttestedState(attestation as AgyLaunchAttestation | undefined, "immediately before launch"),
    postflight: (_descriptor, attestation) =>
      verifyAgyAttestedState(attestation as AgyLaunchAttestation | undefined, "after the managed run"),
    resolveExecutionPolicy: async (_descriptor, _request, _result, launch) =>
      attestAgyNativeInvocation(launch).executionPolicy,
    resolveToolPolicy: async (_descriptor, _request, _result, launch) =>
      attestAgyNativeInvocation(launch).toolPolicy,
    receipt: (descriptor, _request, _result, launch) => {
      const native = attestAgyNativeInvocation(launch);
      return {
        provider: "agy",
        requestedModel: descriptor.model,
        concreteModel: native.model,
        effort: native.effort,
        // No --agent preset is overridden; Agy applies its own default.
        agentPreset: null,
      };
    },
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
