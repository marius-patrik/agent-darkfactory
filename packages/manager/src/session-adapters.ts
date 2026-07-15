import path from "node:path";
import fs from "node:fs";
import { lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionTranscript,
  TurnRequest,
  TurnResult,
} from "../../harness/session";
import { FakeProviderAdapter, renderTranscriptForCli } from "../../harness/session-adapters";
import { canonicalChildEnvironment, resolvePersonalAgentsHome, resolveUserHome } from "./runtime-paths";
import { sharedStateAt, type SharedState } from "./state";
import { rebuildMemoryProjections } from "./memory";
import { commandInvocation } from "./process-command";
import { readProviderRegistry, sha256File, verifyProviderRegistration, type ProviderRegistration } from "./provider-registry";

export interface CliAdapterOptions {
  id: string;
  displayName: string;
  binary: string;
  buildArgs: (request: TurnRequest, transcript: SessionTranscript, descriptor: SessionDescriptor) => string[];
  supportsStreaming?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  parseResult?: (stdout: string, stderr: string, code: number) => TurnResult;
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
   * Fail-closed gate run after the provider process exits and before its
   * output is parsed, returned, or recorded. Receives the exact attestation
   * preflight produced for this run, so verification binds to the pre-launch
   * state instead of trusting whatever the registry contains after exit.
   */
  postflight?: (descriptor: SessionDescriptor, attestation: unknown) => Promise<void>;
  /** Manager-recorded receipt describing the concrete request sent for this launch. */
  receipt?: (descriptor: SessionDescriptor) => Record<string, unknown>;
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
    // Snapshot the initial authority before canonical processing. S0 is a
    // per-run local — no adapter-global mutable slot — so concurrent turns
    // never share or rebind launch authority.
    const attestationS0 = this.options.preflight ? await this.options.preflight(descriptor) : undefined;
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
    forceAgyAutoUpdateDisabled(env, this.id);
    const invocation = commandInvocation(this.options.binary, args, env);
    const spawnOptions = {
      cwd,
      env,
      stdin: "inherit" as const,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };
    if (this.options.verifyPreSpawn) {
      await this.options.verifyPreSpawn(descriptor, attestationS0);
    }
    const proc = Bun.spawn(invocation, spawnOptions);
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
    if (this.options.receipt) result.receipt = this.options.receipt(descriptor);
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

export function canonicalProviderEnv(provider: string, descriptor: SessionDescriptor): Record<string, string> {
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

/** The authenticated Agy Flash model for each canonical reasoning tier. */
const AGY_TIER_MODELS: Record<"low" | "medium" | "high", string> = {
  low: "Gemini 3.5 Flash (Low)",
  medium: "Gemini 3.5 Flash (Medium)",
  high: "Gemini 3.5 Flash (High)",
};

/**
 * Resolve a requested Agy model to the concrete display-name model Agy expects.
 * Agy carries the reasoning tier inside the model string ("... (Low)") and has
 * no separate effort flag, so a canonical tier keyword maps to the concrete
 * authenticated model. An explicit display name passes through with its tier
 * extracted; any other concrete identifier passes through without claiming an
 * effort tier we cannot verify.
 */
export function resolveAgyModel(requestedModel: string): AgyModelResolution {
  const requested = requestedModel.trim();
  const tier = requested.toLowerCase();
  if (tier === "low" || tier === "medium" || tier === "high") {
    return { requestedModel, concreteModel: AGY_TIER_MODELS[tier], effort: tier };
  }
  const display = requested.match(/^(.*?)\s*\((low|medium|high)\)$/i);
  if (display) {
    return { requestedModel, concreteModel: requested, effort: display[2]!.toLowerCase() as AgyModelResolution["effort"] };
  }
  return { requestedModel, concreteModel: requested, effort: null };
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
    case "agy": {
      // Agy's --print consumes the immediately-following argv token as the
      // prompt, so any flag placed after it is swallowed as user input and the
      // model silently falls back to the default. Bind "--model <concrete>"
      // first and place "--print <prompt>" last so the exact prompt and the
      // requested model both apply.
      const { concreteModel } = resolveAgyModel(model);
      return ["--model", concreteModel, "--print", prompt];
    }
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
    receipt: (descriptor) => {
      const resolution = resolveAgyModel(descriptor.model);
      return {
        provider: "agy",
        requestedModel: resolution.requestedModel,
        concreteModel: resolution.concreteModel,
        effort: resolution.effort,
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
