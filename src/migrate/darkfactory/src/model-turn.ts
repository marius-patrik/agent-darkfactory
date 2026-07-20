import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PROMPT_LIBRARY_SCHEMA_VERSION,
  PROMPT_MANIFEST_PATH,
  composePrompt,
  defaultPromptsRoot,
  loadManifest,
  type DraftIntentContext,
  type ImmutablePolicy,
  type IndependentEffort,
  type PromptInputs,
  type RepositoryContext,
  type RunTrigger,
  type ValidationSpec,
  type WorkItemContext
} from "./prompts.ts";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const PROFILE_PATTERN = /^profile\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_PATTERN = /^(?:role|skill|tier|overlay|output)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY_OVERLAYS = Object.freeze([
  "overlay/bun-node",
  "overlay/go",
  "overlay/main-only-private-data",
  "overlay/mixed-monorepo",
  "overlay/python-uv",
  "overlay/submodule-root"
] as const);
const DATA_REPOSITORIES = new Set([
  "marius-patrik/andromeda-data",
  "marius-patrik/darkfactory-data"
]);
const DEFAULT_VERIFIED_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_VERIFIED_FUTURE_SKEW_MS = 5 * 1000;
const SAFE_TURN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_PROCESS_ENVIRONMENT_ALLOWLIST = new Set([
  "AGENTS_HOME",
  "AGENTS_ROOT",
  "AGENTS_SYSTEM_DATA_ROOT",
  "AGENTS_USER_HOME",
  "CI",
  "COMSPEC",
  "GITHUB_ACTIONS",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR"
]);

type RepositoryOverlay = (typeof REPOSITORY_OVERLAYS)[number];

interface VerifiedTurnState {
  observedAt: string;
  facts: string[];
  maxAgeMs?: number;
}

export interface ModelTurnIntent {
  runId: string;
  triggeredBy: RunTrigger;
  profile: string;
  repository: RepositoryContext;
  repositoryPaths: string[];
  workItem: WorkItemContext | null;
  draftIntent: DraftIntentContext | null;
  policy: ImmutablePolicy;
  validation: ValidationSpec;
  verified: VerifiedTurnState;
  effort: IndependentEffort;
  controlRevision: string;
  now?: Date;
}

export interface ModelRequest {
  schemaVersion: number;
  modelTier: string;
  effort: string;
  [key: string]: unknown;
}

interface AgentExecutionReceipt {
  schemaVersion: number;
  requested: { modelTier: string; effort: string };
  resolved: {
    provider: string;
    model: string;
    agentPreset: string;
    providerVersion: string;
  };
  attempts: ReadonlyArray<{ number: number; outcome: string; reason: string | null }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  outcome: "success" | "blocked";
  blockReason: string | null;
}

export interface PromptProvenance {
  schemaVersion: 1;
  controlRevision: string;
  manifest: {
    library: string;
    schemaVersion: number;
    contractVersion: string;
    checksum: string;
  };
  promptChecksum: string;
  inputChecksum: string;
  profile: {
    id: string;
    version: string;
    runKind: string;
    purpose: string;
  };
  selection: {
    role: string;
    skills: string[];
    modelTier: string;
    effort: string;
    overlays: string[];
    repositoryOverlay: string;
    output: string;
  };
  artifacts: Array<{ id: string; version: string; checksum: string }>;
}

export interface ComposedModelTurn {
  prompt: string;
  inputs: PromptInputs;
  provenance: PromptProvenance;
}

export interface ModelTurnAdapters {
  agentRunArguments: (
    request: ModelRequest,
    options: {
      promptFile: string;
      receiptPath: string;
      executionPolicy: "read-only" | "workspace-write";
      mode: string;
    }
  ) => string[];
  validateAgentExecutionReceipt: (
    raw: unknown,
    request: ModelRequest,
    options: { allowBlocked: true }
  ) => AgentExecutionReceipt;
  spawn?: typeof spawnSync;
}

export interface ExecuteModelTurnOptions {
  intent: ModelTurnIntent;
  request: ModelRequest;
  promptsRoot?: string;
  tempRoot: string;
  turnName: string;
  cwd: string;
  executionPolicy: "read-only" | "workspace-write";
  environment?: NodeJS.ProcessEnv;
}

export class ModelTurnError extends Error {
  readonly code: string;
  readonly prompt: PromptProvenance | null;
  readonly receipt: AgentExecutionReceipt | null;

  constructor(
    code: string,
    message: string,
    options: { prompt?: PromptProvenance; receipt?: AgentExecutionReceipt; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelTurnError";
    this.code = code;
    this.prompt = options.prompt ?? null;
    this.receipt = options.receipt ?? null;
  }
}

function checksum(value: string): string {
  return `sha256:${createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function safeStringArray(value: unknown, pattern: RegExp, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !pattern.test(entry))) {
    throw new Error(`${context} is invalid`);
  }
  return [...value];
}

export function validatePromptProvenance(value: unknown): PromptProvenance {
  if (!isRecord(value)) throw new Error("Prompt provenance must be an object");
  exactKeys(
    value,
    ["schemaVersion", "controlRevision", "manifest", "promptChecksum", "inputChecksum", "profile", "selection", "artifacts"],
    "Prompt provenance"
  );
  if (value.schemaVersion !== 1) throw new Error("Prompt provenance schemaVersion must be 1");
  const controlRevision = safeString(value.controlRevision, GIT_REVISION_PATTERN, "Prompt provenance controlRevision");
  if (!isRecord(value.manifest)) throw new Error("Prompt provenance manifest is invalid");
  exactKeys(value.manifest, ["library", "schemaVersion", "contractVersion", "checksum"], "Prompt provenance manifest");
  if (
    typeof value.manifest.library !== "string" ||
    value.manifest.schemaVersion !== PROMPT_LIBRARY_SCHEMA_VERSION ||
    typeof value.manifest.contractVersion !== "string"
  ) {
    throw new Error("Prompt provenance manifest identity is invalid");
  }
  const manifestChecksum = safeString(value.manifest.checksum, SHA256_PATTERN, "Prompt provenance manifest checksum");
  const promptChecksum = safeString(value.promptChecksum, SHA256_PATTERN, "Prompt provenance prompt checksum");
  const inputChecksum = safeString(value.inputChecksum, SHA256_PATTERN, "Prompt provenance input checksum");

  if (!isRecord(value.profile)) throw new Error("Prompt provenance profile is invalid");
  exactKeys(value.profile, ["id", "version", "runKind", "purpose"], "Prompt provenance profile");
  const profile = {
    id: safeString(value.profile.id, PROFILE_PATTERN, "Prompt provenance profile id"),
    version: safeString(value.profile.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Prompt provenance profile version"),
    runKind: safeString(value.profile.runKind, /^[a-z][a-z0-9-]{0,63}$/, "Prompt provenance run kind"),
    purpose: safeString(value.profile.purpose, /^[a-z][a-z0-9-]{0,63}$/, "Prompt provenance purpose")
  };

  if (!isRecord(value.selection)) throw new Error("Prompt provenance selection is invalid");
  exactKeys(
    value.selection,
    ["role", "skills", "modelTier", "effort", "overlays", "repositoryOverlay", "output"],
    "Prompt provenance selection"
  );
  const selection = {
    role: safeString(value.selection.role, /^role\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "Prompt provenance role"),
    skills: safeStringArray(value.selection.skills, /^skill\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "Prompt provenance skills"),
    modelTier: safeString(value.selection.modelTier, /^(?:low|medium|high|max)$/, "Prompt provenance model tier"),
    effort: safeString(value.selection.effort, /^(?:low|medium|high)$/, "Prompt provenance effort"),
    overlays: safeStringArray(value.selection.overlays, /^overlay\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "Prompt provenance overlays"),
    repositoryOverlay: safeString(value.selection.repositoryOverlay, /^overlay\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "Prompt provenance repository overlay"),
    output: safeString(value.selection.output, /^output\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "Prompt provenance output")
  };

  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error("Prompt provenance artifacts are invalid");
  }
  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`Prompt provenance artifact ${index} is invalid`);
    exactKeys(artifact, ["id", "version", "checksum"], `Prompt provenance artifact ${index}`);
    return {
      id: safeString(artifact.id, ARTIFACT_PATTERN, `Prompt provenance artifact ${index} id`),
      version: safeString(artifact.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `Prompt provenance artifact ${index} version`),
      checksum: safeString(artifact.checksum, SHA256_PATTERN, `Prompt provenance artifact ${index} checksum`)
    };
  });

  return Object.freeze({
    schemaVersion: 1,
    controlRevision,
    manifest: Object.freeze({
      library: value.manifest.library,
      schemaVersion: value.manifest.schemaVersion,
      contractVersion: value.manifest.contractVersion,
      checksum: manifestChecksum
    }),
    promptChecksum,
    inputChecksum,
    profile: Object.freeze(profile),
    selection: Object.freeze({
      ...selection,
      skills: Object.freeze(selection.skills) as unknown as string[],
      overlays: Object.freeze(selection.overlays) as unknown as string[]
    }),
    artifacts: Object.freeze(artifacts.map(Object.freeze)) as unknown as Array<{ id: string; version: string; checksum: string }>
  });
}

function normalizedRepositoryPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Repository classification path is invalid");
  }
  return value.toLowerCase();
}

export function classifyRepositoryOverlay(
  repository: Pick<RepositoryContext, "owner" | "repo">,
  repositoryPaths: readonly string[]
): RepositoryOverlay {
  const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
  if (DATA_REPOSITORIES.has(fullName)) return "overlay/main-only-private-data";
  if (!Array.isArray(repositoryPaths) || repositoryPaths.length === 0 || repositoryPaths.length > 100_000) {
    throw new Error("Repository classification requires a complete bounded path inventory");
  }
  const paths = new Set(repositoryPaths.map(normalizedRepositoryPath));
  if (paths.has(".gitmodules")) return "overlay/submodule-root";
  const hasNode = [...paths].some((entry) => entry === "package.json" || entry.endsWith("/package.json"));
  const hasGo = [...paths].some((entry) => /(?:^|\/)(?:go\.mod|go\.work)$/.test(entry));
  const hasPython = [...paths].some((entry) => /(?:^|\/)(?:pyproject\.toml|uv\.lock)$/.test(entry));
  if ([hasNode, hasGo, hasPython].filter(Boolean).length > 1) return "overlay/mixed-monorepo";
  if (hasGo) return "overlay/go";
  if (hasPython) return "overlay/python-uv";
  if (hasNode) return "overlay/bun-node";
  throw new Error("Repository type cannot be classified from verified repository paths");
}

/**
 * Derive the validation lane from the same trusted path inventory used to
 * select the repository overlay. Callers cannot provide a contradictory repo
 * type and validation contract to the prompt composer.
 */
export function validationCommandsForRepository(
  repository: Pick<RepositoryContext, "owner" | "repo">,
  repositoryPaths: readonly string[]
): string[] {
  const overlay = classifyRepositoryOverlay(repository, repositoryPaths);
  const normalized = new Set(repositoryPaths.map(normalizedRepositoryPath));
  if (overlay === "overlay/main-only-private-data") return ["git diff --check"];
  if (overlay === "overlay/submodule-root") {
    return ["git diff --check", "git submodule status --recursive"];
  }
  if (overlay === "overlay/bun-node") return ["npm run check"];
  if (overlay === "overlay/go") return ["go test ./..."];
  if (overlay === "overlay/python-uv") return ["uv run pytest"];

  const commands: string[] = [];
  if ([...normalized].some((entry) => entry === "package.json" || entry.endsWith("/package.json"))) {
    commands.push("npm run check");
  }
  if ([...normalized].some((entry) => /(?:^|\/)(?:go\.mod|go\.work)$/.test(entry))) {
    commands.push("go test ./...");
  }
  if ([...normalized].some((entry) => /(?:^|\/)(?:pyproject\.toml|uv\.lock)$/.test(entry))) {
    commands.push("uv run pytest");
  }
  if (commands.length < 2) throw new Error("Mixed repository validation cannot be derived from verified paths");
  return commands;
}

function verifiedFacts(state: VerifiedTurnState, now: Date): string[] {
  if (!isRecord(state) || !Array.isArray(state.facts) || state.facts.length === 0) {
    throw new Error("Model turns require non-empty verified state");
  }
  const observedAt = new Date(state.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Verified state observedAt is invalid");
  const maxAgeMs = state.maxAgeMs ?? DEFAULT_VERIFIED_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60 * 60 * 1000) {
    throw new Error("Verified state maxAgeMs is invalid");
  }
  const age = now.getTime() - observedAt.getTime();
  if (age < -MAX_VERIFIED_FUTURE_SKEW_MS) throw new Error("Verified state is from the future");
  if (age > maxAgeMs) throw new Error("Verified state is stale");
  return [`Evidence observed at ${observedAt.toISOString()}`, ...state.facts];
}

export async function composeModelTurn(
  intent: ModelTurnIntent,
  promptsRoot: string = defaultPromptsRoot()
): Promise<ComposedModelTurn> {
  const manifest = loadManifest(promptsRoot);
  const profile = manifest.profiles.find((entry) => entry.id === intent.profile);
  if (!profile) throw new Error(`Unknown prompt worker profile: ${intent.profile}`);
  if (!GIT_REVISION_PATTERN.test(intent.controlRevision)) {
    throw new Error("Model turn requires an exact control revision");
  }
  const repositoryOverlay = classifyRepositoryOverlay(intent.repository, intent.repositoryPaths);
  if (!profile.allowedRepositoryOverlays.includes(repositoryOverlay)) {
    throw new Error(`Prompt worker profile ${profile.id} does not allow ${repositoryOverlay}`);
  }
  const inputs: PromptInputs = {
    schemaVersion: PROMPT_LIBRARY_SCHEMA_VERSION,
    run: {
      id: intent.runId,
      kind: profile.runKind,
      purpose: profile.purpose,
      triggeredBy: intent.triggeredBy
    },
    repository: structuredClone(intent.repository),
    workItem: intent.workItem === null ? null : structuredClone(intent.workItem),
    draftIntent: intent.draftIntent === null ? null : structuredClone(intent.draftIntent),
    policy: structuredClone(intent.policy),
    validation: structuredClone(intent.validation),
    effort: intent.effort,
    verified: { facts: verifiedFacts(intent.verified, intent.now ?? new Date()) },
    output: { id: profile.output },
    selection: {
      profile: profile.id,
      role: profile.role,
      skills: [...profile.skills],
      modelTier: profile.modelTier,
      overlays: [...profile.overlays],
      repositoryOverlays: [repositoryOverlay]
    }
  };
  const prompt = composePrompt(inputs, promptsRoot);
  const manifestRaw = await readFile(path.join(promptsRoot, PROMPT_MANIFEST_PATH), "utf8");
  const artifactIds = [
    profile.role,
    ...profile.skills,
    `tier/${profile.modelTier}`,
    ...profile.overlays,
    repositoryOverlay,
    profile.output
  ];
  const artifacts = artifactIds.map((id) => {
    const artifact = manifest.artifacts.find((entry) => entry.id === id);
    if (!artifact) throw new Error(`Prompt provenance is missing artifact ${id}`);
    return { id: artifact.id, version: artifact.version, checksum: artifact.checksum };
  });
  const provenance = validatePromptProvenance({
    schemaVersion: 1,
    controlRevision: intent.controlRevision,
    manifest: {
      library: manifest.library,
      schemaVersion: manifest.schemaVersion,
      contractVersion: manifest.contractVersion,
      checksum: checksum(manifestRaw)
    },
    promptChecksum: checksum(prompt),
    inputChecksum: checksum(canonicalJson(inputs)),
    profile: {
      id: profile.id,
      version: profile.version,
      runKind: profile.runKind,
      purpose: profile.purpose
    },
    selection: {
      role: profile.role,
      skills: [...profile.skills],
      modelTier: profile.modelTier,
      effort: intent.effort,
      overlays: [...profile.overlays],
      repositoryOverlay,
      output: profile.output
    },
    artifacts
  });
  return Object.freeze({ prompt, inputs: structuredClone(inputs), provenance });
}

export function extractModelJson(value: string): unknown {
  const source = String(value || "").trim();
  try {
    return JSON.parse(source);
  } catch {
    // Canonical launchers may print bounded status lines around the final JSON.
  }
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  let candidate: unknown = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start >= 0) {
        try {
          candidate = JSON.parse(source.slice(start, index + 1));
        } catch {
          // Keep scanning for the last complete object.
        }
        start = -1;
      }
    }
  }
  if (candidate === null) throw new ModelTurnError("malformed_result", "Canonical Agent OS did not return a complete JSON object");
  return candidate;
}

function canonicalLauncher(environment: NodeJS.ProcessEnv): string {
  const agentsHome = environment.AGENTS_HOME?.trim() || "";
  if (!agentsHome || !path.isAbsolute(agentsHome)) {
    throw new ModelTurnError("canonical_launcher_unavailable", "A valid absolute AGENTS_HOME is required");
  }
  const launcher = path.join(agentsHome, "bin", "agents.ps1");
  if (!existsSync(launcher)) {
    throw new ModelTurnError("canonical_launcher_unavailable", "Canonical Agent OS launcher is unavailable");
  }
  return launcher;
}

export function agentProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const admitted: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!AGENT_PROCESS_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) continue;
    admitted[name] = value;
  }
  return admitted;
}

function attachPrompt(error: unknown, prompt: PromptProvenance, receipt?: AgentExecutionReceipt): ModelTurnError {
  if (error instanceof ModelTurnError) {
    return new ModelTurnError(error.code, error.message, {
      prompt: error.prompt ?? prompt,
      receipt: error.receipt ?? receipt,
      cause: error
    });
  }
  return new ModelTurnError("model_turn_failed", "Canonical model turn failed closed", {
    prompt,
    receipt,
    cause: error
  });
}

export async function executeModelTurn(
  options: ExecuteModelTurnOptions,
  adapters: ModelTurnAdapters
): Promise<{ output: unknown | null; receipt: AgentExecutionReceipt; prompt: PromptProvenance }> {
  if (!path.isAbsolute(options.tempRoot) || !path.isAbsolute(options.cwd)) {
    throw new ModelTurnError("model_turn_input_invalid", "Model turn paths must be absolute");
  }
  if (!SAFE_TURN_NAME.test(options.turnName)) {
    throw new ModelTurnError("model_turn_input_invalid", "Model turn name is invalid");
  }
  const composed = await composeModelTurn(options.intent, options.promptsRoot);
  if (
    options.request.modelTier !== composed.provenance.selection.modelTier ||
    options.request.effort !== composed.provenance.selection.effort
  ) {
    throw new ModelTurnError("model_request_mismatch", "Authorized model request does not match prompt profile", {
      prompt: composed.provenance
    });
  }
  let receipt: AgentExecutionReceipt | undefined;
  try {
    await mkdir(options.tempRoot, { recursive: true });
    const turnRoot = await mkdtemp(path.join(options.tempRoot, `${options.turnName}-`));
    const promptPath = path.join(turnRoot, "prompt.txt");
    const receiptPath = path.join(turnRoot, "receipt.json");
    await writeFile(promptPath, composed.prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const args = adapters.agentRunArguments(options.request, {
      promptFile: promptPath,
      receiptPath,
      executionPolicy: options.executionPolicy,
      mode: "default"
    });
    const environment = options.environment ?? process.env;
    const child = (adapters.spawn ?? spawnSync)(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-File", canonicalLauncher(environment), ...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
      env: agentProcessEnvironment(environment),
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true
      }
    );
    let rawReceipt: unknown;
    try {
      rawReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch (error) {
      throw new ModelTurnError("agent_receipt_missing", "Canonical Agent OS did not produce an execution receipt", {
        prompt: composed.provenance,
        cause: error
      });
    }
    try {
      receipt = adapters.validateAgentExecutionReceipt(rawReceipt, options.request, { allowBlocked: true });
    } catch (error) {
      throw new ModelTurnError("agent_receipt_invalid", "Canonical Agent OS produced an invalid execution receipt", {
        prompt: composed.provenance,
        cause: error
      });
    }
    if (child.error || (child.status !== 0 && receipt.outcome === "success")) {
      throw new ModelTurnError("provider_route_blocked", "Canonical Agent OS execution failed", {
        prompt: composed.provenance,
        receipt
      });
    }
    if (receipt.outcome !== "success") {
      return Object.freeze({ output: null, receipt, prompt: composed.provenance });
    }
    let output: unknown;
    try {
      output = extractModelJson(typeof child.stdout === "string" ? child.stdout : "");
    } catch (error) {
      throw new ModelTurnError("malformed_result", "Canonical Agent OS returned a malformed model result", {
        prompt: composed.provenance,
        receipt,
        cause: error
      });
    }
    return Object.freeze({ output, receipt, prompt: composed.provenance });
  } catch (error) {
    throw attachPrompt(error, composed.provenance, receipt);
  }
}
