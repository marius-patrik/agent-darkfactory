import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import type { SharedState } from "./state";
import { sharedStateAt } from "./state";
import { readSecret, secretPath, writeSecret } from "./secrets";
import { stateV2Paths, writeTextAtomic, writeTextExclusive } from "./state-v2";
import { inspectMemoryIntegrity, rebuildMemoryProjectionsWhileLocked, withMemoryEventWriteLock } from "./memory";
import {
  inspectSessionIntegrity,
  rebuildSessionProjectionsWhileLocked,
  withSessionWriteLock,
} from "../../sdk/harness/session";
import {
  inspectOrchestratorIntegrity,
  rebuildOrchestratorProjectionWhileLocked,
  withOrchestratorEventWriteLock,
} from "./orchestrator";
import { withStateFileLock } from "./state-lock";

const SYNC_SECRET = "ANDROMEDA_SYNC_KEY";
const AAD_PREFIX = "andromeda-agent-os-event-exchange-v1:";
const SAFE_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const EVENT_FILE = "[0-9]{16}-[A-Za-z0-9_-]+\\.json";
const ALLOWED_EVENT_PATHS = [
  new RegExp(`^memory/events/${SAFE_ID}/${EVENT_FILE}$`),
  new RegExp(`^sessions/${SAFE_ID}/events/${SAFE_ID}/${EVENT_FILE}$`),
  new RegExp(`^orchestrator/events/${SAFE_ID}/${EVENT_FILE}$`),
];
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CANONICAL_HASH_OR_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const COMPACTION_CAPSULE_ID = /^\d{8}-\d{6}-[a-f0-9]{32}$/;
const COMPACTION_SNAPSHOT_STEM = /^\d{8}-\d{6}-[a-f0-9]{32}(?:-rollback)?$/;
const CANONICAL_REPO_SLUG = /^\/?[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?\/[a-z0-9][a-z0-9._-]{0,99}$/;

interface SyncConfig {
  schemaVersion: 2;
  enabled: boolean;
  transport: "encrypted-bundle" | null;
}

interface EventEntry {
  path: string;
  sha256: string;
  content: string;
}

interface BundlePayload {
  schemaVersion: 1;
  source: { installId: string; machineId: string };
  entries: EventEntry[];
}

interface BundleEnvelope {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  payloadHash: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

interface ImportJournal {
  schemaVersion: 1;
  payloadHash: string;
  state: "prepared" | "committed";
  paths: string[];
  entryHashes?: Array<{ path: string; sha256: string; bytes: number }>;
  envelope?: BundleEnvelope;
  imported: number;
  skipped: number;
  projectionHash?: string;
}

export interface EventSyncStatus {
  enabled: boolean;
  transport: string | null;
  keyAvailable: boolean;
  committedImports: number;
  preparedImports: number;
}

export interface EventSyncResult {
  payloadHash: string;
  entries: number;
  imported: number;
  skipped: number;
  projectionHash: string;
  idempotent: boolean;
}

export interface EventBundleInspection {
  payloadHash: string;
  entries: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: string, field: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`event exchange ${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`event exchange ${field} is not canonical base64`);
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error(`event exchange ${field} must be exactly ${expectedBytes} bytes`);
  }
  return decoded;
}

function syncConfigPath(state: SharedState): string {
  return path.join(stateV2Paths(state).syncDir, "config.json");
}

function importsDirectory(state: SharedState): string {
  return path.join(stateV2Paths(state).syncDir, "imports");
}

async function readConfig(state: SharedState): Promise<SyncConfig> {
  const configPath = syncConfigPath(state);
  await assertPhysicalPathUnderRoot(state.stateDir, configPath, { leaf: "file" });
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<SyncConfig>;
  if (
    parsed.schemaVersion !== 2 ||
    typeof parsed.enabled !== "boolean" ||
    (parsed.transport !== null && parsed.transport !== "encrypted-bundle")
  ) {
    throw new Error("invalid event exchange configuration");
  }
  return parsed as SyncConfig;
}

async function keyMaterial(state: SharedState): Promise<Buffer> {
  let value: string;
  try {
    value = await readSecret(state, SYNC_SECRET);
  } catch {
    throw new Error(`event exchange requires a local ${SYNC_SECRET} secret`);
  }
  const normalized = value.trim();
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${SYNC_SECRET} must contain exactly 32 bytes encoded as 64 hexadecimal characters`);
  }
  return Buffer.from(normalized, "hex");
}

function assertAllowedPath(relativePath: string): void {
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !ALLOWED_EVENT_PATHS.some((pattern) => pattern.test(relativePath))
  ) {
    throw new Error(`event exchange payload contains a forbidden path: ${relativePath}`);
  }
}

async function assertPhysicalPathUnderRoot(
  root: string,
  target: string,
  options: { allowMissing?: boolean; leaf?: "directory" | "file" | "any" } = {},
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`event exchange path escapes canonical state: ${resolvedTarget}`);
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = resolvedRoot;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`event exchange path contains a symbolic link: ${current}`);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) {
      throw new Error(`event exchange path ancestor is not a physical directory: ${current}`);
    }
    if (isLeaf && options.leaf === "directory" && !info.isDirectory()) {
      throw new Error(`event exchange path is not a physical directory: ${current}`);
    }
    if (isLeaf && options.leaf === "file" && !info.isFile()) {
      throw new Error(`event exchange path is not a physical file: ${current}`);
    }
  }
  return true;
}

async function ensurePhysicalDirectoryChain(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`event exchange path escapes canonical state: ${resolvedDirectory}`);
  }
  await assertPhysicalPathUnderRoot(resolvedRoot, resolvedRoot, { leaf: "directory" });
  let current = resolvedRoot;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertPhysicalPathUnderRoot(resolvedRoot, current, { leaf: "directory" });
  }
}

const STRUCTURAL_STRING_FIELDS = new Set([
  "id",
  "recordId",
  "agentId",
  "machineId",
  "sessionId",
  "turnId",
  "supersedes",
  "eventHash",
  "previousEventHash",
  "contentHash",
  "at",
  "createdAt",
  "updatedAt",
  "observedAt",
  "validFrom",
  "expiresAt",
  "leaseExpiresAt",
  "lastBeatAt",
  "nextCheckAt",
]);

// Dream cursor authority fields reference provider transcript artifacts by
// their uuid filename. That exact leaf shape is admitted for these two fields
// only; every other field keeps the fail-closed opaque-token treatment.
const SESSION_ARTIFACT_URI_FIELDS = new Set(["pathUri", "lastSessionTitleUri"]);
const SESSION_ARTIFACT_LEAF =
  /(^|[\\/])[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:jsonl|json)(?=$|[\\/])/gi;

const PUBLIC_OPERATIONAL_IDENTIFIERS = new Set([
  "online/offline/busy/version/labels/last",
  "lifecycle/persistence/registration/supervision/observability",
  "updatePackagesAndEnvironmentsState",
  "./node_modules/typescript/bin/tsc",
  "platform/now/doctor/scheduler/host/readCredential/username",
  "marius-patrik/fix/windows-state-lock-post-release",
  "create/delete/query/enable/disable",
  "create/query/enable/disable/delete",
  "install/enable/disable/repair/run",
  "install/enable/disable/status/repair/run",
  "packages/manager/src/runner-lifecycle.ts",
  "packages/manager/src/session-adapters.ts",
  "packages/manager/src/adapters.ts",
  "packages/manager/src/route-probe.ts",
  "packages/manager/src/process-command.ts",
  "packages/manager/test/runner-lifecycle.test.ts",
  "packages/manager/test/session-adapters.test.ts",
  "packages/manager/test/adapters.test.ts",
  "packages/manager/test/route-probe.test.ts",
  "manager/test/state-doctor.test.ts",
  "platform/now/doctor/scheduler/github/host",
  "native-kimi-supported-canonical-append",
  "native-codex-supported-canonical-append",
  "native-claude-fable-supported-canonical-append",
  "CLI/help/runner/state-schema/manifest/lockfile/unrelated",
  "credential/config/executable/provider-home",
  "auth/unavailable/internal/malformed",
  "task/binding/doctor/launcher/process/control-plane/online",
  "System.Security.Principal.WindowsIdentity",
  "Microsoft.Management.Infrastructure.CimException",
  "action/trigger/principal/settings/New-ScheduledTask",
  "reconcileRegistrations/reconcileProcesses",
  "provision/configure/register/create",
  "installed/registered/doctor/launcher",
  "printActionResult/printStatusReport",
  "enableRunner/disableRunner/runRunner",
  "ANDROMEDA_HOME/ANDROMEDA_USER_ROOT/ANDROMEDA_ROOT...",
  "ANDROMEDA_HOME/ANDROMEDA_USER_HOME/ANDROMEDA_ROOT...",
  "name/enabled/state/actionExecutable/actionArguments",
  "installed/registered/persistence/process/online/labels/launcher/doctor/record",
  "durationMs/outputBytes/truncated",
  "readSessionConfig/writeSessionConfig",
  "executor-finished-before-timeout",
  "process.env.USERDOMAIN/COMPUTERNAME",
  "Unknown/Disabled/Queued/Ready/Running",
  "TaskName/Enabled/known-State/Execute/Arguments",
  "effort_unreachable/workspace_write_unreachable",
  "preflight/launch/postflight/receipt",
  "modes/ownership/immutable/read-only",
  "missing/null/wrong-type/unknown/empty/partial",
  "top-level/list/id/name/os/status/busy/label",
  "credential/auth/network/nonzero/malformed-output",
  "authorized-max-tier-after-kimi-zero-edit-timeout",
  "authorized-edit-only-after-zero-edit-tool-surface-failure",
  "argv/model/home/auth/attestation/drift/receipt",
  "test_quota_window_is_clock_driven",
  "test_cloud_route_requires_opt_in_and_fails_closed_on_bad_budget",
  // Public manager documentation names this storage location; the path is not
  // credential material. Descendants and any actual credential value remain in
  // the fail-closed scanner.
  "clis/agy/.gemini/oauth_creds.json",
]);

const PUBLIC_RELEASE_BRANCH_WORDS = new Set(["after", "main", "reconcile", "release"]);

// These basenames are public diagnostic artifacts named in canonical evidence.
// Keep this closed over complete leaves: a lexical or numeric filename heuristic
// can accidentally admit passphrase-shaped material inside an absolute path.
const PUBLIC_ABSOLUTE_PATH_LEAVES = new Set([
  "andromeda-253-kimi-blockers.txt",
  "andromeda-260-kimi-blockers.txt",
]);

// Some canonical evidence predates the stable diagnostic names above. Pin the
// complete public basename without copying rejected event text into source or
// logs. Hash pinning admits only that exact leaf; extensions and descendants
// still enter the fail-closed path-token scanner.
const PUBLIC_ABSOLUTE_PATH_LEAF_HASHES = new Set([
  "94e8c98f13c41e8698a9b48326297bc7c52fa290a2a2ab6ae1f9ce6b07eccf48",
  // hygiene-run-20260717.md — canonical hygiene evidence under provenance/ (#294).
  "a766731b018adc8a927e429e6b4c7fd5d9239e161708271ddae78008f071b013",
]);

function isPublicOperationalIdentifier(candidate: string): boolean {
  if (PUBLIC_OPERATIONAL_IDENTIFIERS.has(candidate)) return true;
  const normalizedCandidate = candidate.endsWith(".") ? candidate.slice(0, -1) : candidate;
  if (PUBLIC_OPERATIONAL_IDENTIFIERS.has(normalizedCandidate)) return true;
  if (/^(?:query\/)?[a-z]{3,20}\/permission\/malformed-output$/.test(normalizedCandidate)) return true;
  if (/^session_[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/.test(normalizedCandidate)) {
    return true;
  }
  if (
    /^(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*[0-9])[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/.test(
      normalizedCandidate,
    )
  ) {
    return true;
  }
  if (
    /^Microsoft\.PowerShell\.Cmdletization\.GeneratedTypes\.ScheduledTask\.[A-Z][A-Za-z]{2,48}$/.test(
      normalizedCandidate,
    )
  ) {
    return true;
  }
  if (
    /^\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/(?:issues|pull)\/[1-9][0-9]*$/.test(
      normalizedCandidate,
    )
  ) {
    return true;
  }

  // A repository branch reference is public metadata only when it names the
  // canonical owner and the complete, documented release-reconciliation lane.
  // The repository segment remains lexical, while every branch word is closed
  // over the explicit release vocabulary. Arbitrary slash-delimited prose is
  // deliberately excluded from this admission.
  const branch = normalizedCandidate.match(
    /^marius-patrik\/[a-z][a-z0-9.-]{1,38}\/(?:[a-z]+-){2,}[a-z]+$/,
  );
  if (!branch) return false;
  const branchName = normalizedCandidate.slice(normalizedCandidate.lastIndexOf("/") + 1);
  return (
    branchName === "reconcile-main-after-release" &&
    branchName.split("-").every((word) => PUBLIC_RELEASE_BRANCH_WORDS.has(word))
  );
}

function secretLikeText(value: string): boolean {
  // Canonical docs and tests may name the upstream local-reset command or the
  // deliberately non-secret registration fixture. Strip only those bounded
  // public literals before explicit-assignment and entropy inspection;
  // lookalikes and extensions remain in the fail-closed lane.
  const inspectedValue = value
    .replace(
      /(?<![A-Za-z0-9_])(?:ghr_)?FAKE_REGISTRATION_TOKEN(?:_0123456789)?(?![A-Za-z0-9_])/g,
      "",
    )
    // Admit only the two complete public command examples. In particular,
    // never erase a `token:` assignment prefix independently of its value.
    .replace(/(?<![A-Za-z0-9])`config\.cmd remove --local`(?![A-Za-z0-9_])/gi, "")
    .replace(/(?<![A-Za-z0-9])`token=abc123`(?![A-Za-z0-9_])/gi, "")
    .replace(
      /(?<![A-Za-z0-9])`config\.cmd --url https:\/\/github\.com\/[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?\/[a-z0-9][a-z0-9._-]{0,99} --token <token> --labels \.\.\.`(?![A-Za-z0-9_])/gi,
      "",
    );
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(inspectedValue) ||
    /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/.test(inspectedValue) ||
    /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/.test(inspectedValue) ||
    /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/.test(inspectedValue) ||
    /(?<![A-Za-z0-9])(?:sk-(?:ant-|proj-)?|xox[baprs]-|hf_|npm_|pypi-)[A-Za-z0-9_\-]{16,}(?![A-Za-z0-9_\-])/.test(
      inspectedValue,
    ) ||
    /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/.test(inspectedValue) ||
    /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/.test(
      inspectedValue,
    ) ||
    /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}(?![A-Za-z0-9._~+\/=-])/i.test(
      inspectedValue,
    ) ||
    /(?<![A-Za-z0-9])(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s/:@]+:[^\s/@]+@/i.test(
      inspectedValue,
    ) ||
    /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|connection[_-]?string|dsn)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      inspectedValue,
    )
  ) {
    return true;
  }
  // Evidence fields can embed local file URIs; explicit secret signatures above
  // still scan the full value, while URI path material is excluded only from the
  // generic high-entropy fallback.
  const pathClosers = new Map<string, string>([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
    ["<", ">"],
  ]);
  const hardUnquotedPathBoundary = (character: string): boolean =>
    /[\r\n\t"'`\[\]{}<>,;:=|?*]/.test(character);
  const looksLikeFileLeaf = (component: string): boolean =>
    /[^.]\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(component.trim());
  const containsOpaquePathToken = (
    segment: string,
    isLeaf: boolean,
    canonicalCompactionSnapshotLeaf: boolean,
  ): boolean => {
    const normalized = segment.trim();
    const inspectedSegment = isLeaf && normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
    if (isLeaf && canonicalCompactionSnapshotLeaf) return false;
    if (
      isLeaf &&
      (PUBLIC_ABSOLUTE_PATH_LEAVES.has(inspectedSegment.toLowerCase()) ||
        PUBLIC_ABSOLUTE_PATH_LEAF_HASHES.has(createHash("sha256").update(inspectedSegment).digest("hex")))
    ) {
      return false;
    }
    if (UUID.test(inspectedSegment)) return true;
    const datedWordSlugFile = inspectedSegment.match(
      /^([a-z]{3,15}(?:-[a-z]{3,15}){2,})-(\d{8})\.([a-z0-9]{1,10})$/,
    );
    if (isLeaf && datedWordSlugFile) {
      const lexicalWords = (datedWordSlugFile[1] ?? "").split("-");
      const vowelCounts = lexicalWords.map((word) => (word.match(/[aeiouy]/g) ?? []).length);
      if (
        vowelCounts.every((count) => count >= 2) &&
        lexicalWords.every((word) => !/[^aeiouy]{4}/.test(word))
      ) {
        return false;
      }
    }
    // A long lexical slug can itself be a passphrase. Once the complete public
    // leaves and the pre-existing dated-artifact form have been handled above,
    // keep any remaining three-or-more-part slug in the fail-closed lane even
    // when its Shannon score happens to be low.
    if (
      isLeaf &&
      /^(?:[a-z]{3,15}-){2,}(?:[a-z]{3,15}|\d{1,8})\.[a-z0-9]{1,10}$/.test(inspectedSegment)
    ) {
      return true;
    }
    return (inspectedSegment.match(/[A-Za-z0-9_+.-]{16,}/g) ?? []).some((candidate) => {
      const token = candidate.replace(/[_+.-]/g, "");
      if (candidate.length >= 32) return true;
      if (token.length < 16) return false;
      const counts = new Map<string, number>();
      for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
      const entropy = [...counts.values()].reduce((total, count) => {
        const probability = count / token.length;
        return total - probability * Math.log2(probability);
      }, 0);
      return entropy >= 4;
    });
  };
  const findPathEnd = (
    input: string,
    start: number,
    limit: number,
    delimited: boolean,
  ): number => {
    let end = start;
    let componentStart = start;
    while (end < limit) {
      const character = input[end] ?? "";
      if (/\s/.test(character)) {
        if (character !== " ") break;
        // Whitespace is ambiguous in free-form diagnostics: the same bytes can
        // be a multi-word path or a path followed by unrelated secret material.
        // Require a matched quote/bracket as structured producer evidence.
        if (!delimited) break;
        const currentComponent = input.slice(componentStart, end);
        if (looksLikeFileLeaf(currentComponent)) break;
        if (["//", "\\\\"].includes(input.slice(end + 1, end + 3))) break;
        end += 1;
        continue;
      }
      if (hardUnquotedPathBoundary(character)) break;
      if (character === "/" || character === "\\") {
        componentStart = end + 1;
      }
      end += 1;
    }
    return end;
  };
  const omitInspectedAbsolutePaths = (input: string): { value: string; longSegment: boolean } => {
    const output = input.split("");
    const omitted = new Array<boolean>(input.length).fill(false);
    let longSegment = false;
    let matchedCloserByOpener: Int32Array | null = null;
    const delimitedPathEnd = (openerIndex: number): number | null => {
      if (!matchedCloserByOpener) {
        const matches = new Int32Array(input.length);
        matches.fill(-1);
        const structuralOpeners = new Set(["(", "[", "{", "<"]);
        const openerByCloser = new Map([
          [")", "("],
          ["]", "["],
          ["}", "{"],
          [">", "<"],
        ]);
        const structuralStack: Array<{ character: string; index: number }> = [];
        const pendingQuotes = new Map<string, number>([
          ['"', -1],
          ["'", -1],
          ["`", -1],
        ]);
        for (let index = 0; index < input.length; index += 1) {
          const character = input[index] ?? "";
          if (character === "\r" || character === "\n") {
            structuralStack.length = 0;
            for (const quote of pendingQuotes.keys()) pendingQuotes.set(quote, -1);
            continue;
          }
          const pendingQuote = pendingQuotes.get(character);
          if (pendingQuote !== undefined) {
            if (pendingQuote < 0) pendingQuotes.set(character, index);
            else {
              matches[pendingQuote] = index;
              pendingQuotes.set(character, -1);
            }
          }
          if (structuralOpeners.has(character)) {
            structuralStack.push({ character, index });
            continue;
          }
          const expectedOpener = openerByCloser.get(character);
          if (!expectedOpener) continue;
          const pendingOpener = structuralStack.at(-1);
          if (pendingOpener?.character === expectedOpener) {
            matches[pendingOpener.index] = index;
            structuralStack.pop();
          } else if (pendingOpener) {
            // Crossing or mismatched delimiters do not establish a trustworthy
            // path boundary. Invalidate the open structure on this line.
            structuralStack.length = 0;
          }
        }
        matchedCloserByOpener = matches;
      }
      const end = matchedCloserByOpener[openerIndex] ?? -1;
      return end >= 0 ? end : null;
    };
    const roots = /(?<![A-Za-z0-9_+.\-\\/])(?:[A-Za-z]:[\\/]|\\\\|\/(?![\\/]))/g;
    for (const match of input.matchAll(roots)) {
      const start = match.index;
      const root = match[0];
      if (start === undefined || omitted[start]) continue;
      const opener = input[start - 1] ?? "";
      const delimitedEnd = pathClosers.has(opener)
        ? delimitedPathEnd(start - 1)
        : undefined;
      // An unmatched quote/bracket is ambiguous. Leave it in the generic
      // fail-closed lane instead of treating the rest of the line as a path.
      if (delimitedEnd === null) continue;
      const end = findPathEnd(
        input,
        start + root.length,
        delimitedEnd ?? input.length,
        delimitedEnd !== undefined,
      );
      if (end <= start + root.length || /[\u0000-\u001f\u007f]/.test(input.slice(start, end))) continue;
      const absolutePath = input.slice(start, end);
      const pathSegments = absolutePath.split(/[\\/]+/);
      let leafIndex = pathSegments.length - 1;
      while (leafIndex >= 0 && !(pathSegments[leafIndex] ?? "").trim()) leafIndex -= 1;
      const normalizedPath = absolutePath.replaceAll("\\", "/");
      const compactionSnapshot = normalizedPath.match(
        /\/\.agents\/memory\/snapshots\/compaction\/([^/]+)\.json$/,
      );
      const canonicalCompactionSnapshotLeaf = COMPACTION_SNAPSHOT_STEM.test(compactionSnapshot?.[1] ?? "");
      if (pathSegments.some((segment, index) =>
        containsOpaquePathToken(segment, index === leafIndex, canonicalCompactionSnapshotLeaf)
      )) {
        longSegment = true;
      }
      for (let index = start; index < end; index += 1) {
        output[index] = " ";
        omitted[index] = true;
      }
    }
    return { value: output.join(""), longSegment };
  };
  let entropyInput = inspectedValue
    // Strip only the scheme of an unambiguous local file URI. The remaining
    // absolute path must pass the same segment inspection as native paths.
    .replace(/\bfile:\/\/(?=\/|[A-Za-z]:[\\/])/gi, (scheme) => " ".repeat(scheme.length))
    // Canonical GitHub repository URLs and an adjacent, explicitly labelled
    // repository lineage are identifiers, not bearer material. The lineage
    // exemption intentionally accepts one to three identifier segments with at
    // least two dots or hyphens. Routes, queries, and unlabelled slash-delimited
    // strings still reach the generic entropy guard below.
    .replace(
      /\bhttps?:\/\/github\.com\/[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?\/[a-z0-9][a-z0-9._-]{0,99}(?=[\s),;]|$)/gi,
      "",
    )
    .replace(
      /\(renamed from (?=[a-z0-9._/-]*(?:[-.][a-z0-9._/-]*){2})[a-z0-9][a-z0-9._-]{0,99}(?:\/[a-z0-9][a-z0-9._-]{0,99}){1,2}\)/gi,
      "",
    );
  // Inspect only exact, bounded local-path spans. Forward `//` remains ambiguous
  // URL material and stays in the fail-closed generic lane.
  const inspectedPaths = omitInspectedAbsolutePaths(entropyInput);
  if (inspectedPaths.longSegment) return true;
  entropyInput = inspectedPaths.value
    // Remove only a credential-free HTTP(S) origin after local path inspection.
    // Repository slugs and opaque path/query material remain in the fallback.
    .replace(/\bhttps?:\/\/(?:\[[^\]]+\]|[^\s/:@]+)(?::\d+)?(?=\/)/gi, "")
    // These two repository-relative DarkFactory control artifacts are stable
    // local identifiers produced by the trusted worker boundary. Keep the
    // exemption exact and segment-bounded; descendants and lookalikes still
    // enter the generic entropy guard below.
    .replace(
      /(?<![-A-Za-z0-9_+.\\/])\.darkfactory[\\/]df-(?:task-brief|worker-summary)\.md(?![-A-Za-z0-9_+\\/]|\.[A-Za-z0-9])/g,
      "",
    )
    // Canonical public instructions use these exact trust-boundary, CLI lane,
    // and runner lifecycle shorthands. Keep them token-bounded so prefixes,
    // descendants, and lookalikes remain subject to the generic slash-token
    // entropy guard.
    .replace(
      /(?<![-A-Za-z0-9_+.\\/])(?:review\/admin\/bypass\/force-push\/deletion|CLI\/state\/secrets\/source-install|install\/enable\/disable\/status\/repair)(?![-A-Za-z0-9_+\\/]|\.[A-Za-z0-9])/g,
      "",
    );
  for (const candidate of entropyInput.match(/[A-Za-z0-9_+.\\/-]{32,}={0,2}/g) ?? []) {
    if (UUID.test(candidate)) continue;
    if (/^-?(?:[a-f0-9]{40}|[a-f0-9]{64})\.?$/.test(candidate)) continue;
    // Bare GitHub-style owner/repository slugs in prose are identifiers. Requiring
    // repository punctuation avoids exempting arbitrary lowercase slash tokens.
    if (CANONICAL_REPO_SLUG.test(candidate) && /[.-]/.test(candidate)) continue;
    if (
      /^\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\.git)?$/.test(
        candidate,
      )
    ) {
      continue;
    }
    if (
      /^(?:(?:\/\/github\.com)?\/actions\/runner\/releases\/download\/v)?\d+\.\d+\.\d+\/actions-runner-(?:linux|osx|win)-[a-z0-9-]+-\d+\.\d+\.\d+\.(?:tar\.gz|zip)\.?$/.test(
        candidate,
      ) ||
      /^actions-runner-(?:linux|osx|win)-[a-z0-9-]+-\d+\.\d+\.\d+\.(?:tar\.gz|zip)\.?$/.test(candidate) ||
      /^\/?repos\/actions\/runner\/releases\/assets\/[0-9]+$/.test(candidate)
    ) {
      continue;
    }
    if (isPublicOperationalIdentifier(candidate)) continue;
    if (/[A-Za-z]/.test(candidate) && (/[0-9]/.test(candidate) || /[_+\\/-]/.test(candidate))) {
      return true;
    }
    if (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate)) {
      const counts = new Map<string, number>();
      for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
      const entropy = [...counts.values()].reduce((total, count) => {
        const probability = count / candidate.length;
        return total - probability * Math.log2(probability);
      }, 0);
      if (entropy >= 4) {
        return true;
      }
    }
  }
  return false;
}

function hasDuplicateJsonObjectKeys(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const skipWhitespace = (): void => {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  };
  const parseString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        offset += 1;
        parseValue();
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue();
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (source[offset] === '"') {
      parseString();
      return;
    }
    while (offset < source.length && !/[\s,}\]]/.test(source[offset])) offset += 1;
  };
  parseValue();
  return duplicate;
}

function secretFieldPath(value: unknown, field = "", path = ""): string | null {
  if (typeof value === "string") {
    if (STRUCTURAL_STRING_FIELDS.has(field) && (UUID.test(value) || CANONICAL_HASH_OR_ID.test(value))) return null;
    if (field === "capsuleId" && COMPACTION_CAPSULE_ID.test(value)) return null;
    const inspected = SESSION_ARTIFACT_URI_FIELDS.has(field)
      ? value.replace(SESSION_ARTIFACT_LEAF, "$1session-artifact.jsonl")
      : value;
    const trimmed = inspected.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      let structured: unknown;
      try {
        structured = JSON.parse(trimmed) as unknown;
      } catch {
        return secretLikeText(inspected) ? path || field || "<root>" : null;
      }
      if (structured !== null && typeof structured === "object") {
        try {
          if (hasDuplicateJsonObjectKeys(trimmed)) return path || field || "<root>";
          return secretFieldPath(structured, field, path);
        } catch {
          return path || field || "<root>";
        }
      }
    }
    return secretLikeText(inspected) ? path || field || "<root>" : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretFieldPath(item, field, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (
      /(?:password|passwd|pwd|secret|token|api.?key|credential|authorization|private.?key|connection.?string|dsn)/i.test(key) &&
      typeof nested === "string" &&
      nested.length > 0
    ) {
      return nestedPath;
    }
    const found = secretFieldPath(nested, key, nestedPath);
    if (found) return found;
  }
  return null;
}

/** Manager-owned fail-closed admission policy for content entering roaming canonical state. */
export function findSecretLikePath(value: unknown): string | null {
  return secretFieldPath(value);
}

function assertSourceMetadata(source: { installId: string; machineId: string }): void {
  for (const field of ["installId", "machineId"] as const) {
    const value = source[field];
    if (!UUID.test(value)) {
      throw new Error(`event exchange source ${field} is not a canonical non-secret identifier`);
    }
  }
}

function assertNoPlantedSecret(relativePath: string, content: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`event exchange payload is not valid JSON at ${relativePath}: ${String(error)}`);
  }
  const record = (parsed as { data?: { record?: { sensitivity?: unknown } } }).data?.record;
  if (record?.sensitivity === "secret") {
    throw new Error(`secret memory events are local-only and cannot roam: ${relativePath}`);
  }
  const plantedSecret = secretFieldPath(parsed);
  if (plantedSecret) {
    throw new Error(`event exchange payload contains a secret-like field at ${plantedSecret}: ${relativePath}`);
  }
  return parsed;
}

function assertEventPathIdentity(relativePath: string, parsed: unknown): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`event exchange path identity requires an event object: ${relativePath}`);
  }
  const event = parsed as { id?: unknown; machineId?: unknown; machineSequence?: unknown; sessionId?: unknown };
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  const match = fileName.match(/^([0-9]{16})-([A-Za-z0-9_-]+)\.json$/);
  const machineId = segments[0] === "memory" ? segments[2] : segments[0] === "sessions" ? segments[3] : segments[2];
  const sessionId = segments[0] === "sessions" ? segments[1] : undefined;
  if (
    !match ||
    event.machineId !== machineId ||
    event.machineSequence !== Number(match[1]) ||
    event.id !== match[2] ||
    (sessionId !== undefined && event.sessionId !== sessionId)
  ) {
    throw new Error(`event exchange path identity mismatch: ${relativePath}`);
  }
}

async function collectFiles(
  state: SharedState,
  relativeDirectory: string,
  entries: EventEntry[],
  scanSecrets: boolean,
): Promise<void> {
  const absoluteDirectory = path.join(state.stateDir, ...relativeDirectory.split("/"));
  try {
    await assertPhysicalPathUnderRoot(state.stateDir, absoluteDirectory, { leaf: "directory" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) throw new Error(`hidden entries cannot roam: ${path.join(absoluteDirectory, entry.name)}`);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const entryInfo = await lstat(absolutePath);
    await assertPhysicalPathUnderRoot(state.stateDir, absolutePath);
    if (entryInfo.isDirectory()) {
      await collectFiles(state, relativePath, entries, scanSecrets);
      continue;
    }
    if (!entryInfo.isFile()) throw new Error(`event exchange source contains an unsupported entry: ${absolutePath}`);
    assertAllowedPath(relativePath);
    if (entryInfo.size > MAX_FILE_BYTES) throw new Error(`event exchange event is too large: ${relativePath}`);
    const content = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    if (scanSecrets) parsed = assertNoPlantedSecret(relativePath, content);
    else {
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new Error(`local event history is not valid JSON at ${relativePath}: ${String(error)}`);
      }
    }
    assertEventPathIdentity(relativePath, parsed);
    entries.push({ path: relativePath, sha256: sha256(content), content: Buffer.from(content).toString("base64") });
    if (entries.length > MAX_FILES) throw new Error(`event exchange exceeds ${MAX_FILES} files`);
  }
}

async function collectEventEntries(state: SharedState, scanSecrets = true): Promise<EventEntry[]> {
  const entries: EventEntry[] = [];
  await collectFiles(state, "memory/events", entries, scanSecrets);
  const sessionsRoot = path.join(state.stateDir, "sessions");
  try {
    await assertPhysicalPathUnderRoot(state.stateDir, sessionsRoot, { leaf: "directory" });
    for (const entry of (await readdir(sessionsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) throw new Error(`hidden canonical session entries cannot roam: ${entry.name}`);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid canonical session entry: ${entry.name}`);
      await collectFiles(state, `sessions/${entry.name}/events`, entries, scanSecrets);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await collectFiles(state, "orchestrator/events", entries, scanSecrets);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function decodeEntries(entries: EventEntry[]): Map<string, string> {
  if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new Error("invalid event exchange entry list");
  const decoded = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.content !== "string") {
      throw new Error("invalid event exchange entry");
    }
    assertAllowedPath(entry.path);
    if (decoded.has(entry.path)) throw new Error(`duplicate event exchange path: ${entry.path}`);
    const bytes = Buffer.from(entry.content, "base64");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`event exchange event is too large: ${entry.path}`);
    const content = bytes.toString("utf8");
    if (Buffer.from(content, "utf8").toString("base64") !== entry.content) {
      throw new Error(`event exchange entry is not canonical UTF-8 base64: ${entry.path}`);
    }
    if (sha256(content) !== entry.sha256) throw new Error(`event exchange entry hash mismatch: ${entry.path}`);
    assertEventPathIdentity(entry.path, assertNoPlantedSecret(entry.path, content));
    decoded.set(entry.path, content);
  }
  const sorted = [...decoded.keys()].sort();
  if (entries.some((entry, index) => entry.path !== sorted[index])) throw new Error("event exchange entries are not sorted");
  return decoded;
}

async function authenticateBundleEnvelope(
  state: SharedState,
  value: unknown,
): Promise<{ envelope: BundleEnvelope; payloadHash: string; payload: BundlePayload; incoming: Map<string, string> }> {
  const envelope = value as Partial<BundleEnvelope>;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.algorithm !== "aes-256-gcm" ||
    typeof envelope.payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.payloadHash) ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.authTag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("invalid event exchange envelope");
  }
  const normalized = envelope as BundleEnvelope;
  const nonce = canonicalBase64(normalized.nonce, "nonce", 12);
  const authTag = canonicalBase64(normalized.authTag, "authentication tag", 16);
  const ciphertext = canonicalBase64(normalized.ciphertext, "ciphertext");
  const key = await keyMaterial(state);
  let plaintextBytes: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${normalized.payloadHash}`));
    decipher.setAuthTag(authTag);
    plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("event exchange authentication failed");
  }
  if (plaintextBytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("event exchange payload is too large");
  const plaintext = plaintextBytes.toString("utf8");
  if (sha256(plaintext) !== normalized.payloadHash) throw new Error("event exchange payload hash mismatch");
  const payload = JSON.parse(plaintext) as Partial<BundlePayload>;
  if (
    payload.schemaVersion !== 1 ||
    !payload.source ||
    typeof payload.source.installId !== "string" ||
    typeof payload.source.machineId !== "string" ||
    !Array.isArray(payload.entries)
  ) {
    throw new Error("invalid event exchange payload");
  }
  assertSourceMetadata(payload.source);
  const completePayload = payload as BundlePayload;
  return {
    envelope: normalized,
    payloadHash: normalized.payloadHash,
    payload: completePayload,
    incoming: decodeEntries(completePayload.entries),
  };
}

async function readAuthenticatedEventBundle(state: SharedState, inputPath: string) {
  const resolved = path.resolve(inputPath);
  const inputInfo = await lstat(resolved);
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) throw new Error("event exchange bundle must be a physical file");
  if (inputInfo.size > MAX_BUNDLE_BYTES * 2) throw new Error("event exchange envelope is too large");
  return authenticateBundleEnvelope(state, JSON.parse(await readFile(resolved, "utf8")));
}

export async function inspectEventBundle(state: SharedState, inputPath: string): Promise<EventBundleInspection> {
  const authenticated = await readAuthenticatedEventBundle(state, inputPath);
  return { payloadHash: authenticated.payloadHash, entries: authenticated.incoming.size };
}

async function validateMergedEvents(state: SharedState, incoming: Map<string, string>): Promise<Map<string, string>> {
  const combined = new Map((await collectEventEntries(state, false)).map((entry) => [entry.path, Buffer.from(entry.content, "base64").toString("utf8")]));
  for (const [relativePath, content] of incoming) {
    const existing = combined.get(relativePath);
    if (existing !== undefined && existing !== content) throw new Error(`immutable event collision: ${relativePath}`);
    combined.set(relativePath, content);
  }

  const validationRoot = await mkdtemp(path.join(stateV2Paths(state).syncDir, "validate-"));
  try {
    await mkdir(path.join(validationRoot, "memory", "events"), { recursive: true });
    for (const [relativePath, content] of combined) {
      const target = path.join(validationRoot, ...relativePath.split("/"));
      if (!(await writeTextExclusive(target, content))) throw new Error(`duplicate validation event: ${relativePath}`);
    }
    const shadow = sharedStateAt(state.root, validationRoot, state.userHome);
    const [memory, sessions, orchestrator] = await Promise.all([
      inspectMemoryIntegrity(shadow),
      inspectSessionIntegrity(shadow),
      inspectOrchestratorIntegrity(shadow),
    ]);
    if (!memory.eventIntegrity) throw new Error(`merged memory events are invalid: ${memory.issues.join("; ")}`);
    if (!sessions.eventIntegrity) throw new Error(`merged session events are invalid: ${sessions.issues.join("; ")}`);
    if (!orchestrator.eventIntegrity) throw new Error(`merged orchestrator events are invalid: ${orchestrator.issues.join("; ")}`);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
  return combined;
}

async function projectionHashForCapturedEntries(state: SharedState, entries: EventEntry[]): Promise<string> {
  const validationRoot = await mkdtemp(path.join(stateV2Paths(state).syncDir, "export-validate-"));
  try {
    await mkdir(path.join(validationRoot, "memory", "events"), { recursive: true });
    const captured = new Map<string, string>();
    for (const entry of entries) {
      const content = Buffer.from(entry.content, "base64").toString("utf8");
      const target = path.join(validationRoot, ...entry.path.split("/"));
      if (!(await writeTextExclusive(target, content))) throw new Error(`duplicate captured event: ${entry.path}`);
      captured.set(entry.path, content);
    }
    const shadow = sharedStateAt(state.root, validationRoot, state.userHome);
    const [memory, sessions, orchestrator] = await Promise.all([
      inspectMemoryIntegrity(shadow),
      inspectSessionIntegrity(shadow),
      inspectOrchestratorIntegrity(shadow),
    ]);
    if (!memory.eventIntegrity) throw new Error(`captured memory events are invalid: ${memory.issues.join("; ")}`);
    if (!sessions.eventIntegrity) throw new Error(`captured session events are invalid: ${sessions.issues.join("; ")}`);
    if (!orchestrator.eventIntegrity) throw new Error(`captured orchestrator events are invalid: ${orchestrator.issues.join("; ")}`);
    return await rebuildImportedProjectionsWhileLocked(shadow, captured);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

async function projectionHash(state: SharedState, incoming: Map<string, string>): Promise<string> {
  const hashes: string[] = [];
  const includeMemory = [...incoming.keys()].some((item) => item.startsWith("memory/"));
  const includeOrchestrator = [...incoming.keys()].some((item) => item.startsWith("orchestrator/"));
  const sessionIds = new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  );
  const visit = async (relativeDirectory: string, accept: (name: string) => boolean): Promise<void> => {
    const directory = path.join(state.stateDir, ...relativeDirectory.split("/"));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relativePath, accept);
      else if (entry.isFile() && accept(entry.name)) hashes.push(`${relativePath}:${sha256(await readFile(path.join(directory, entry.name)))}`);
    }
  };
  if (includeMemory) {
    await visit("memory/records", (name) => name.endsWith(".json"));
    await visit("memory/views", (name) => name.endsWith(".md"));
  }
  for (const sessionId of [...sessionIds].sort()) {
    await visit(`sessions/${sessionId}`, (name) => name === "state.json" || name === "transcript.json");
  }
  if (includeOrchestrator) await visit("orchestrator", (name) => name === "state.json" || name === "STATE.md");
  return sha256(hashes.sort().join("\n"));
}

async function rebuildImportedProjectionsWhileLocked(state: SharedState, incoming: Map<string, string>): Promise<string> {
  if ([...incoming.keys()].some((item) => item.startsWith("memory/"))) await rebuildMemoryProjectionsWhileLocked(state);
  const sessionIds = new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  );
  for (const sessionId of [...sessionIds].sort()) await rebuildSessionProjectionsWhileLocked(state, sessionId);
  if ([...incoming.keys()].some((item) => item.startsWith("orchestrator/"))) {
    await rebuildOrchestratorProjectionWhileLocked(state);
  }
  return projectionHash(state, incoming);
}

async function withAffectedEventLocks<T>(
  state: SharedState,
  incoming: Map<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const lockOrchestrator = [...incoming.keys()].some((item) => item.startsWith("orchestrator/"));
  const lockMemory = [...incoming.keys()].some((item) => item.startsWith("memory/"));
  const sessionIds = [...new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  )].sort();
  const afterSessions = (): Promise<T> => {
    const afterMemory = () => lockOrchestrator ? withOrchestratorEventWriteLock(state, callback) : callback();
    return lockMemory ? withMemoryEventWriteLock(state, "event-sync-import", afterMemory) : afterMemory();
  };
  const lockSessions = async (index: number): Promise<T> => {
    const sessionId = sessionIds[index];
    if (!sessionId) return afterSessions();
    return withSessionWriteLock(state, sessionId, () => lockSessions(index + 1));
  };
  return lockSessions(0);
}

function entryMetadata(incoming: Map<string, string>): Array<{ path: string; sha256: string; bytes: number }> {
  return [...incoming.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({
      path: relativePath,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    }));
}

async function preparedJournalEntries(state: SharedState, journal: ImportJournal): Promise<Map<string, string>> {
  if (!journal.envelope) throw new Error(`prepared event import ${journal.payloadHash} has no durable authenticated envelope`);
  const authenticated = await authenticateBundleEnvelope(state, journal.envelope);
  if (authenticated.payloadHash !== journal.payloadHash) {
    throw new Error(`prepared event import ${journal.payloadHash} does not match its authenticated envelope`);
  }
  const incoming = authenticated.incoming;
  const expectedMetadata = entryMetadata(incoming);
  if (!journal.entryHashes || JSON.stringify(journal.entryHashes) !== JSON.stringify(expectedMetadata)) {
    throw new Error(`prepared event import ${journal.payloadHash} has inconsistent authenticated entry metadata`);
  }
  if (journal.paths.length !== incoming.size || journal.paths.some((item, index) => item !== [...incoming.keys()][index])) {
    throw new Error(`prepared event import ${journal.payloadHash} has inconsistent recovery paths`);
  }
  return incoming;
}

function assertSameIncoming(left: Map<string, string>, right: Map<string, string>): void {
  if (left.size !== right.size) throw new Error("prepared event import does not match the supplied authenticated bundle");
  for (const [relativePath, content] of left) {
    if (right.get(relativePath) !== content) {
      throw new Error(`prepared event import does not match the supplied authenticated bundle: ${relativePath}`);
    }
  }
}

async function publishPreparedImport(
  state: SharedState,
  payloadHash: string,
  incoming: Map<string, string>,
  journalPath: string,
  prepared: ImportJournal,
  options: {
    failAfter?: number;
    afterValidationBeforePublication?: () => Promise<void>;
    beforeProjection?: () => Promise<void>;
  } = {},
): Promise<EventSyncResult> {
  await validateMergedEvents(state, incoming);
  await options.afterValidationBeforePublication?.();
  let imported = 0;
  const created = new Map<string, string>();
  for (const [relativePath, content] of incoming) {
    const target = path.join(state.stateDir, ...relativePath.split("/"));
    await ensurePhysicalDirectoryChain(state.stateDir, path.dirname(target));
    await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
    if (await writeTextExclusive(target, content)) {
      imported += 1;
      created.set(target, content);
    }
    else if ((await readFile(target, "utf8")) !== content) throw new Error(`immutable event collision: ${relativePath}`);
    if (options.failAfter !== undefined && imported >= options.failAfter) {
      throw new Error("simulated interrupted event import");
    }
  }
  await options.beforeProjection?.();
  try {
    await validateMergedEvents(state, new Map());
  } catch (error) {
    for (const [target, content] of [...created.entries()].reverse()) {
      try {
        if ((await readFile(target, "utf8")) === content) await rm(target, { force: true });
      } catch (rollbackError) {
        if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") throw rollbackError;
      }
    }
    throw error;
  }
  const finalProjectionHash = await rebuildImportedProjectionsWhileLocked(state, incoming);
  const committed: ImportJournal = {
    ...prepared,
    state: "committed",
    imported,
    skipped: incoming.size - imported,
    projectionHash: finalProjectionHash,
  };
  await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
  await writeTextAtomic(journalPath, `${JSON.stringify(committed, null, 2)}\n`);
  return {
    payloadHash,
    entries: incoming.size,
    imported,
    skipped: incoming.size - imported,
    projectionHash: finalProjectionHash,
    idempotent: false,
  };
}

export async function enableEventSync(state: SharedState, generateKey = false): Promise<void> {
  if (generateKey) {
    try {
      await lstat(secretPath(state, SYNC_SECRET));
      throw new Error(`${SYNC_SECRET} already exists; refusing implicit key rotation`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeSecret(state, SYNC_SECRET, randomBytes(32).toString("hex"));
  }
  await keyMaterial(state);
  await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
  await assertPhysicalPathUnderRoot(state.stateDir, syncConfigPath(state), { allowMissing: true, leaf: "file" });
  await writeTextAtomic(
    syncConfigPath(state),
    `${JSON.stringify({ schemaVersion: 2, enabled: true, transport: "encrypted-bundle" }, null, 2)}\n`,
  );
}

export async function disableEventSync(state: SharedState): Promise<void> {
  await ensurePhysicalDirectoryChain(state.stateDir, path.dirname(syncConfigPath(state)));
  await assertPhysicalPathUnderRoot(state.stateDir, syncConfigPath(state), { allowMissing: true, leaf: "file" });
  await writeTextAtomic(syncConfigPath(state), `${JSON.stringify({ schemaVersion: 2, enabled: false, transport: null }, null, 2)}\n`);
}

export async function eventSyncStatus(state: SharedState): Promise<EventSyncStatus> {
  const config = await readConfig(state);
  let keyAvailable = true;
  try {
    await keyMaterial(state);
  } catch {
    keyAvailable = false;
  }
  let committedImports = 0;
  let preparedImports = 0;
  try {
    await assertPhysicalPathUnderRoot(state.stateDir, importsDirectory(state), { leaf: "directory" });
    for (const entry of await readdir(importsDirectory(state), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = path.join(importsDirectory(state), entry.name);
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      if (journal.state === "committed") committedImports += 1;
      else if (journal.state === "prepared") preparedImports += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { enabled: config.enabled, transport: config.transport, keyAvailable, committedImports, preparedImports };
}

export async function exportEventBundle(
  state: SharedState,
  outputPath: string,
  options: { afterCollection?: () => Promise<void> } = {},
): Promise<EventSyncResult> {
  const config = await readConfig(state);
  if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
  const key = await keyMaterial(state);
  const manifest = JSON.parse(await readFile(stateV2Paths(state).manifestFile, "utf8")) as { installId: string; machineId: string };
  assertSourceMetadata(manifest);
  const [memory, sessions, orchestrator] = await Promise.all([
    inspectMemoryIntegrity(state),
    inspectSessionIntegrity(state),
    inspectOrchestratorIntegrity(state),
  ]);
  if (!memory.eventIntegrity) throw new Error(`cannot export invalid memory events: ${memory.issues.join("; ")}`);
  if (!sessions.eventIntegrity) throw new Error(`cannot export invalid session events: ${sessions.issues.join("; ")}`);
  if (!orchestrator.eventIntegrity) throw new Error(`cannot export invalid orchestrator events: ${orchestrator.issues.join("; ")}`);
  const entries = await collectEventEntries(state);
  await options.afterCollection?.();
  const capturedProjectionHash = await projectionHashForCapturedEntries(state, entries);
  const payload: BundlePayload = { schemaVersion: 1, source: manifest, entries };
  const plaintext = JSON.stringify(payload);
  if (Buffer.byteLength(plaintext) > MAX_BUNDLE_BYTES) throw new Error("event exchange bundle is too large");
  const payloadHash = sha256(plaintext);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${payloadHash}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: BundleEnvelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    payloadHash,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await writeTextAtomic(path.resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`);
  return { payloadHash, entries: entries.length, imported: 0, skipped: 0, projectionHash: capturedProjectionHash, idempotent: false };
}

export async function importEventBundle(
  state: SharedState,
  inputPath: string,
  options: {
    failAfter?: number;
    afterValidationBeforePublication?: () => Promise<void>;
    beforeProjection?: () => Promise<void>;
  } = {},
): Promise<EventSyncResult> {
  return withStateFileLock(state, "event-sync-import", async () => {
    const config = await readConfig(state);
    if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
    const authenticated = await readAuthenticatedEventBundle(state, inputPath);
    const { payloadHash, incoming } = authenticated;
    const journalPath = path.join(importsDirectory(state), `${payloadHash}.json`);
    await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
    await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
    return withAffectedEventLocks(state, incoming, async () => {
      let journal: ImportJournal | null = null;
      try {
        await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
        journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (journal && (journal.schemaVersion !== 1 || journal.payloadHash !== payloadHash)) {
        throw new Error(`invalid event import journal: ${payloadHash}`);
      }
      if (journal?.state === "committed") {
        let complete = true;
        for (const [relativePath, content] of incoming) {
          const target = path.join(state.stateDir, ...relativePath.split("/"));
          await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
          try {
            if ((await readFile(target, "utf8")) !== content) {
              throw new Error(`immutable event collision: ${relativePath}`);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") complete = false;
            else throw error;
          }
        }
        if (complete) {
          await validateMergedEvents(state, incoming);
          return {
            payloadHash,
            entries: incoming.size,
            imported: 0,
            skipped: incoming.size,
            projectionHash: await projectionHash(state, incoming),
            idempotent: true,
          };
        }
      }

      if (journal?.state === "prepared") {
        const durableIncoming = await preparedJournalEntries(state, journal);
        assertSameIncoming(durableIncoming, incoming);
        return publishPreparedImport(state, payloadHash, durableIncoming, journalPath, journal, options);
      }

      await validateMergedEvents(state, incoming);
      let skipped = 0;
      for (const [relativePath, content] of incoming) {
        const target = path.join(state.stateDir, ...relativePath.split("/"));
        await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
        try {
          const current = await readFile(target, "utf8");
          if (current !== content) throw new Error(`immutable event collision: ${relativePath}`);
          skipped += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
      const prepared: ImportJournal = {
        schemaVersion: 1,
        payloadHash,
        state: "prepared",
        paths: [...incoming.keys()],
        entryHashes: entryMetadata(incoming),
        envelope: authenticated.envelope,
        imported: 0,
        skipped,
      };
      await writeTextAtomic(journalPath, `${JSON.stringify(prepared, null, 2)}\n`);
      return publishPreparedImport(state, payloadHash, incoming, journalPath, prepared, options);
    });
  });
}

export async function recoverPreparedEventImports(state: SharedState): Promise<EventSyncResult[]> {
  return withStateFileLock(state, "event-sync-import", async () => {
    const config = await readConfig(state);
    if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
    await assertPhysicalPathUnderRoot(state.stateDir, importsDirectory(state), { leaf: "directory" });
    const results: EventSyncResult[] = [];
    for (const entry of (await readdir(importsDirectory(state), { withFileTypes: true }))
      .filter((item) => item.isFile() && item.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const journalPath = path.join(importsDirectory(state), entry.name);
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      const filePayloadHash = entry.name.slice(0, -".json".length);
      if (
        journal.schemaVersion !== 1 ||
        journal.payloadHash !== filePayloadHash ||
        !/^[a-f0-9]{64}$/.test(journal.payloadHash) ||
        !Array.isArray(journal.paths) ||
        (journal.state !== "prepared" && journal.state !== "committed")
      ) {
        throw new Error(`invalid event import journal: ${entry.name}`);
      }
      if (journal.state === "committed") continue;
      const incoming = await preparedJournalEntries(state, journal);
      results.push(await withAffectedEventLocks(state, incoming, () => (
        publishPreparedImport(state, journal.payloadHash, incoming, journalPath, journal)
      )));
    }
    return results;
  });
}
