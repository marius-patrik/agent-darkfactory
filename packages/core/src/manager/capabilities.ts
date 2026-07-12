import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import {
  readPackageManifest,
  readPackageRegistrations,
  type AgentsPackageManifest,
  type PackageRegistration,
} from "./packages";
import {
  readInstalls,
  type InstallKind,
  type InstallRecord,
  type SharedState,
} from "./state";
import { stateV2Paths, writeTextAtomic, writeTextIfChanged } from "./state-v2";
import { canonicalChildEnvironment } from "./runtime-paths";

export type CapabilityKind = Extract<
  InstallKind,
  "skill" | "plugin" | "hook" | "template" | "cli" | "harness"
>;

export interface CapabilityInstallOptions {
  kind: CapabilityKind;
  name: string;
  source: string;
  replace?: boolean;
  now?: Date;
  transactionHooks?: CapabilityTransactionHooks;
}

export interface CapabilityInstallResult {
  record: InstallRecord;
  changed: boolean;
  replaced: boolean;
}

export interface IdentityActivationResult {
  sha256: string;
  changed: boolean;
  path: string;
}

export interface CapabilityIntegrityInspection {
  ok: boolean;
  installs: number;
  storeObjects: number;
  identitySha256: string | null;
  issues: string[];
}

export type CapabilityPublicationBoundary =
  | "store"
  | "target"
  | "installs"
  | "packages"
  | "capabilities-view"
  | "provenance";

export interface CapabilityTransactionHooks {
  /** Test seam for proving rollback at a completed publication boundary. */
  afterPublish?: (
    boundary: CapabilityPublicationBoundary,
  ) => void | Promise<void>;
}

interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file";
  executable: boolean;
  bytes?: Uint8Array;
}

interface ValidatedTree {
  sha256: string;
  entries: TreeEntry[];
}

type PublicationKind = "file" | "directory";

interface PreparedPublication {
  boundary: CapabilityPublicationBoundary;
  kind: PublicationKind;
  target: string;
  staged: string;
  backup: string;
  originalPresent: boolean;
  originalSha256: string | null;
}

interface CapabilityTransactionJournal {
  schemaVersion: 1;
  id: string;
  operation: "capability-install" | "identity-activation";
  status: "staging" | "prepared" | "committed";
  stateRoot: string;
  publications: PreparedPublication[];
}

interface CapabilityTransaction {
  id: string;
  directory: string;
  journalFile: string;
  journal: CapabilityTransactionJournal;
}

const installKinds = new Set<CapabilityKind>([
  "skill",
  "plugin",
  "hook",
  "template",
  "cli",
  "harness",
]);
const packageManifestKinds = new Set<CapabilityKind>([
  "plugin",
  "hook",
  "template",
  "cli",
  "harness",
]);
const executableManifestKinds = new Set<CapabilityKind>([
  "hook",
  "cli",
  "harness",
]);
const packageManifestFields = new Set([
  "schemaVersion",
  "id",
  "name",
  "kind",
  "description",
  "entry",
  "workingDirectory",
  "requires",
  "dataRepo",
  "provides",
]);
const forbiddenTreeSegments = new Set([
  ".git",
  ".agents",
  ".codex",
  ".claude",
  ".kimi-code",
  ".gemini",
  ".rommie",
]);
const maximumFiles = 10_000;
const maximumBytes = 100 * 1024 * 1024;

function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(`invalid capability name: ${name}`);
  }
}

function assertKind(kind: string): asserts kind is CapabilityKind {
  if (!installKinds.has(kind as CapabilityKind)) {
    throw new Error(
      "install kind must be skill, plugin, hook, template, cli, or harness",
    );
  }
}

function targetBase(state: SharedState, kind: CapabilityKind): string {
  switch (kind) {
    case "skill":
      return state.skillsDir;
    case "plugin":
      return state.pluginsDir;
    case "hook":
      return state.hooksDir;
    case "template":
      return state.templatesDir;
    case "harness":
      return state.harnessesDir;
    case "cli":
      return state.clisDir;
  }
}

function assertSafeEntry(relativePath: string): void {
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (forbiddenTreeSegments.has(segment.toLowerCase())) {
      throw new Error(
        `capability contains forbidden nested state: ${relativePath}`,
      );
    }
  }

  const base = segments.at(-1)?.toLowerCase() ?? "";
  const secretLike =
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "auth.json" ||
    base === "credentials.json" ||
    base === "secrets.json" ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    /\.(?:key|pem|p12|pfx)$/i.test(base);
  if (secretLike)
    throw new Error(`capability contains secret-like file: ${relativePath}`);
}

async function inspectTree(root: string): Promise<ValidatedTree> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`capability source must be a physical directory: ${root}`);
  }

  const entries: TreeEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const children = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      assertSafeEntry(relativePath);
      const absolutePath = path.join(directory, child.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink())
        throw new Error(`capability symlinks are forbidden: ${relativePath}`);
      if (info.isDirectory()) {
        entries.push({ relativePath, kind: "directory", executable: false });
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile())
        throw new Error(
          `capability contains unsupported entry: ${relativePath}`,
        );

      fileCount += 1;
      totalBytes += info.size;
      if (fileCount > maximumFiles)
        throw new Error(`capability exceeds ${maximumFiles} files`);
      if (totalBytes > maximumBytes)
        throw new Error(`capability exceeds ${maximumBytes} bytes`);
      const bytes = await readFile(absolutePath);
      const textPrefix = bytes
        .subarray(0, Math.min(bytes.length, 4096))
        .toString("utf8");
      if (
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(textPrefix)
      ) {
        throw new Error(
          `capability contains private-key material: ${relativePath}`,
        );
      }
      entries.push({
        relativePath,
        kind: "file",
        executable: (info.mode & 0o111) !== 0,
        bytes,
      });
    }
  }

  await walk(root, "");
  if (fileCount === 0) throw new Error("capability source is empty");

  return { sha256: digestEntries(entries), entries };
}

function digestEntries(entries: TreeEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(
      entry.kind === "directory" ? "D\0" : entry.executable ? "X\0" : "F\0",
    );
    hash.update(entry.relativePath);
    hash.update("\0");
    if (entry.bytes) {
      hash.update(String(entry.bytes.byteLength));
      hash.update("\0");
      hash.update(entry.bytes);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function parseSkillFrontmatter(
  content: string,
  filePath: string,
): { name: string; description: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n"))
    throw new Error(`${filePath}: SKILL.md requires YAML frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1)
    throw new Error(`${filePath}: unterminated SKILL.md frontmatter`);
  const fields = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields.set(match[1], value);
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!name || !description)
    throw new Error(`${filePath}: SKILL.md requires name and description`);
  return { name, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalString(
  value: unknown,
  field: string,
  manifestFile: string,
): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${manifestFile}: ${field} must be a non-empty string`);
  }
}

function assertStringArray(
  value: unknown,
  field: string,
  manifestFile: string,
): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      `${manifestFile}: ${field} must be an array of non-empty strings`,
    );
  }
}

async function validateCanonicalManifestShape(
  manifestFile: string,
): Promise<void> {
  const raw = JSON.parse(await readFile(manifestFile, "utf8")) as unknown;
  if (!isRecord(raw))
    throw new Error(`${manifestFile}: manifest must be an object`);
  for (const field of Object.keys(raw)) {
    if (!packageManifestFields.has(field)) {
      throw new Error(`${manifestFile}: unsupported manifest field ${field}`);
    }
  }
  if (raw.schemaVersion !== 1)
    throw new Error(`${manifestFile}: schemaVersion must be 1`);
  assertOptionalString(raw.id, "id", manifestFile);
  assertOptionalString(raw.kind, "kind", manifestFile);
  for (const field of ["name", "description", "entry", "workingDirectory"]) {
    assertOptionalString(raw[field], field, manifestFile);
  }
  if (raw.requires !== undefined) {
    if (!isRecord(raw.requires))
      throw new Error(`${manifestFile}: requires must be an object`);
    for (const field of Object.keys(raw.requires)) {
      if (field !== "clis" && field !== "state") {
        throw new Error(`${manifestFile}: unsupported requires field ${field}`);
      }
      assertStringArray(raw.requires[field], `requires.${field}`, manifestFile);
    }
  }
  if (raw.dataRepo !== undefined) {
    if (!isRecord(raw.dataRepo))
      throw new Error(`${manifestFile}: dataRepo must be an object`);
    const allowed = new Set([
      "id",
      "repo",
      "path",
      "branch",
      "managedPath",
      "env",
    ]);
    for (const field of Object.keys(raw.dataRepo)) {
      if (!allowed.has(field)) {
        throw new Error(`${manifestFile}: unsupported dataRepo field ${field}`);
      }
    }
    for (const field of ["id", "repo", "path"]) {
      assertOptionalString(
        raw.dataRepo[field],
        `dataRepo.${field}`,
        manifestFile,
      );
      if (raw.dataRepo[field] === undefined) {
        throw new Error(`${manifestFile}: dataRepo.${field} is required`);
      }
    }
    for (const field of ["branch", "managedPath", "env"]) {
      assertOptionalString(
        raw.dataRepo[field],
        `dataRepo.${field}`,
        manifestFile,
      );
    }
  }
  if (raw.provides !== undefined) {
    assertStringArray(raw.provides, "provides", manifestFile);
  }
}

async function validatePayload(
  root: string,
  kind: CapabilityKind,
  name: string,
): Promise<ValidatedTree> {
  const tree = await inspectTree(root);
  if (kind === "skill") {
    const skillFile = path.join(root, "SKILL.md");
    if (!(await exists(skillFile)))
      throw new Error(`${root}: skill requires SKILL.md`);
    const frontmatter = parseSkillFrontmatter(
      await readFile(skillFile, "utf8"),
      skillFile,
    );
    if (frontmatter.name !== name) {
      throw new Error(
        `${skillFile}: frontmatter name ${frontmatter.name} does not match install name ${name}`,
      );
    }
  }

  const canonicalManifest = path.join(root, "agent.package.json");
  const hasCanonicalManifest = await exists(canonicalManifest);
  for (const retiredName of ["agents.package.json", "agent.json"]) {
    if (await exists(path.join(root, retiredName))) {
      throw new Error(
        `${root}: capability manifests must use agent.package.json; ${retiredName} is not supported`,
      );
    }
  }
  if (packageManifestKinds.has(kind) && !hasCanonicalManifest) {
    throw new Error(`${root}: ${kind} requires agent.package.json`);
  }
  if (hasCanonicalManifest) {
    await validateCanonicalManifestShape(canonicalManifest);
  }
  const packageManifest = await readPackageManifest(root);
  if (packageManifest) {
    if (packageManifest.id !== name)
      throw new Error(
        `package manifest id ${packageManifest.id} does not match ${name}`,
      );
    if (packageManifest.kind !== kind) {
      throw new Error(
        `package manifest kind ${packageManifest.kind} does not match ${kind}`,
      );
    }
    if (executableManifestKinds.has(kind) && !packageManifest.entry?.trim()) {
      throw new Error(
        `${canonicalManifest}: ${kind} requires a non-empty entry command`,
      );
    }
  }
  return tree;
}

async function normalizeModes(
  root: string,
  entries: TreeEntry[],
): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(root, 0o700);
  for (const entry of entries) {
    await chmod(
      path.join(root, entry.relativePath),
      entry.kind === "directory" ? 0o700 : entry.executable ? 0o700 : 0o600,
    );
  }
}

async function syncTree(root: string, entries: TreeEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const handle = await open(path.join(root, entry.relativePath), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .sort(
      (left, right) =>
        right.relativePath.split("/").length -
        left.relativePath.split("/").length,
    );
  for (const entry of directories) {
    await syncDirectory(path.join(root, entry.relativePath));
  }
  await syncDirectory(root);
}

async function runGitClone(source: string, target: string): Promise<void> {
  const child = Bun.spawn(
    [
      "git",
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--single-branch",
      "--",
      source,
      target,
    ],
    {
      env: canonicalChildEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git clone failed: ${stderr.trim()}`);
  await rm(path.join(target, ".git"), { recursive: true, force: true });
}

async function materializeSource(
  state: SharedState,
  source: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const temporaryRoot = path.join(
    stateV2Paths(state).runtimeDir,
    "tmp",
    `capability-source-${process.pid}-${randomUUID()}`,
  );
  const payload = path.join(temporaryRoot, "payload");
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
  try {
    const absoluteSource = path.resolve(source);
    if (await exists(absoluteSource)) {
      const sourceInfo = await lstat(absoluteSource);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new Error(
          `capability source must be a physical directory: ${source}`,
        );
      }
      await cp(absoluteSource, payload, {
        recursive: true,
        preserveTimestamps: true,
      });
    } else if (
      /^(?:https|ssh):\/\//.test(source) ||
      /^[^/@\s]+@[^:\s]+:.+/.test(source)
    ) {
      await runGitClone(source, payload);
    } else {
      throw new Error(`capability source does not exist: ${source}`);
    }
    return {
      root: payload,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function lstatOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertWithinState(state: SharedState, candidate: string): string {
  const stateRoot = path.resolve(state.stateDir);
  const resolved = path.resolve(candidate);
  const relative = path.relative(stateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (resolved === stateRoot) return resolved;
    throw new Error(
      `capability transaction path escapes canonical state: ${candidate}`,
    );
  }
  return resolved;
}

function transactionRoot(state: SharedState): string {
  return path.join(
    stateV2Paths(state).runtimeDir,
    "transactions",
    "capabilities",
  );
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileDigest(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function publicationDigest(
  item: Pick<PreparedPublication, "kind" | "target">,
): Promise<string> {
  return item.kind === "directory"
    ? (await inspectTree(item.target)).sha256
    : fileDigest(item.target);
}

function relativeTransactionPath(
  transaction: CapabilityTransaction,
  filePath: string,
): string {
  const relative = path.relative(transaction.directory, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`invalid capability transaction path: ${filePath}`);
  }
  return relative;
}

async function writeTransactionJournal(
  transaction: CapabilityTransaction,
): Promise<void> {
  await writeTextAtomic(
    transaction.journalFile,
    `${JSON.stringify(transaction.journal, null, 2)}\n`,
  );
  await syncDirectory(transaction.directory);
}

async function beginCapabilityTransaction(
  state: SharedState,
  operation: CapabilityTransactionJournal["operation"],
): Promise<CapabilityTransaction> {
  const root = transactionRoot(state);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(root, 0o700);
  const id = `${operation}-${process.pid}-${randomUUID()}`;
  const directory = path.join(root, id);
  await mkdir(path.join(directory, "staged"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "backups"), {
    recursive: true,
    mode: 0o700,
  });
  const transaction: CapabilityTransaction = {
    id,
    directory,
    journalFile: path.join(directory, "journal.json"),
    journal: {
      schemaVersion: 1,
      id,
      operation,
      status: "staging",
      stateRoot: path.resolve(state.stateDir),
      publications: [],
    },
  };
  await writeTransactionJournal(transaction);
  await syncDirectory(root);
  return transaction;
}

async function prepareDirectoryPublication(
  state: SharedState,
  transaction: CapabilityTransaction,
  boundary: CapabilityPublicationBoundary,
  targetPath: string,
  build: (staged: string) => Promise<void>,
): Promise<PreparedPublication | null> {
  const target = assertWithinState(state, targetPath);
  const index = transaction.journal.publications.length;
  const staged = path.join(
    transaction.directory,
    "staged",
    String(index).padStart(3, "0"),
  );
  const backup = path.join(
    transaction.directory,
    "backups",
    String(index).padStart(3, "0"),
  );
  await build(staged);
  const stagedInfo = await lstat(staged);
  if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink())
    throw new Error(
      `staged publication is not a physical directory: ${target}`,
    );
  const stagedTree = await inspectTree(staged);
  await syncTree(staged, stagedTree.entries);

  const originalInfo = await lstatOrNull(target);
  if (
    originalInfo &&
    (!originalInfo.isDirectory() || originalInfo.isSymbolicLink())
  ) {
    throw new Error(
      `publication target is not a physical directory: ${target}`,
    );
  }
  const originalSha256 = originalInfo
    ? (await inspectTree(target)).sha256
    : null;
  if (originalSha256 === stagedTree.sha256) {
    await rm(staged, { recursive: true, force: true });
    return null;
  }
  const publication: PreparedPublication = {
    boundary,
    kind: "directory",
    target,
    staged: relativeTransactionPath(transaction, staged),
    backup: relativeTransactionPath(transaction, backup),
    originalPresent: Boolean(originalInfo),
    originalSha256,
  };
  transaction.journal.publications.push(publication);
  return publication;
}

async function prepareTreeCopyPublication(
  state: SharedState,
  transaction: CapabilityTransaction,
  boundary: CapabilityPublicationBoundary,
  target: string,
  sourceRoot: string,
  expected: ValidatedTree,
): Promise<PreparedPublication | null> {
  return prepareDirectoryPublication(
    state,
    transaction,
    boundary,
    target,
    async (staged) => {
      await cp(sourceRoot, staged, {
        recursive: true,
        preserveTimestamps: true,
      });
      await normalizeModes(staged, expected.entries);
      const copied = await inspectTree(staged);
      if (copied.sha256 !== expected.sha256)
        throw new Error(
          `capability changed while staging publication: ${target}`,
        );
    },
  );
}

async function prepareStorePublication(
  state: SharedState,
  transaction: CapabilityTransaction,
  sourceRoot: string,
  tree: ValidatedTree,
): Promise<string> {
  const storePath = path.join(
    stateV2Paths(state).capabilityStoreDir,
    tree.sha256,
  );
  const existing = await lstatOrNull(storePath);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error(`corrupt capability store object: ${tree.sha256}`);
    if ((await inspectTree(storePath)).sha256 !== tree.sha256)
      throw new Error(`corrupt capability store object: ${tree.sha256}`);
    return storePath;
  }
  await prepareTreeCopyPublication(
    state,
    transaction,
    "store",
    storePath,
    sourceRoot,
    tree,
  );
  return storePath;
}

async function prepareFilePublication(
  state: SharedState,
  transaction: CapabilityTransaction,
  boundary: CapabilityPublicationBoundary,
  targetPath: string,
  content: string,
): Promise<PreparedPublication | null> {
  const target = assertWithinState(state, targetPath);
  const originalInfo = await lstatOrNull(target);
  if (
    originalInfo &&
    (!originalInfo.isFile() || originalInfo.isSymbolicLink())
  ) {
    throw new Error(`publication target is not a physical file: ${target}`);
  }
  if (originalInfo && (await readFile(target, "utf8")) === content) return null;

  const index = transaction.journal.publications.length;
  const staged = path.join(
    transaction.directory,
    "staged",
    String(index).padStart(3, "0"),
  );
  const backup = path.join(
    transaction.directory,
    "backups",
    String(index).padStart(3, "0"),
  );
  await writeTextAtomic(staged, content, 0o600);
  const publication: PreparedPublication = {
    boundary,
    kind: "file",
    target,
    staged: relativeTransactionPath(transaction, staged),
    backup: relativeTransactionPath(transaction, backup),
    originalPresent: Boolean(originalInfo),
    originalSha256: originalInfo ? await fileDigest(target) : null,
  };
  transaction.journal.publications.push(publication);
  return publication;
}

function absolutePublicationPaths(
  transaction: CapabilityTransaction,
  publication: PreparedPublication,
) {
  return {
    staged: path.join(transaction.directory, publication.staged),
    backup: path.join(transaction.directory, publication.backup),
  };
}

async function assertOriginalUnchanged(
  publication: PreparedPublication,
): Promise<void> {
  const info = await lstatOrNull(publication.target);
  if (!publication.originalPresent) {
    if (info)
      throw new Error(
        `publication target appeared during transaction: ${publication.target}`,
      );
    return;
  }
  if (!info)
    throw new Error(
      `publication target disappeared during transaction: ${publication.target}`,
    );
  const digest = await publicationDigest(publication);
  if (digest !== publication.originalSha256)
    throw new Error(
      `publication target changed during transaction: ${publication.target}`,
    );
}

async function rollbackPublication(
  transaction: CapabilityTransaction,
  publication: PreparedPublication,
): Promise<void> {
  const { staged, backup } = absolutePublicationPaths(transaction, publication);
  const [stagedInfo, backupInfo] = await Promise.all([
    lstatOrNull(staged),
    lstatOrNull(backup),
  ]);
  if (backupInfo) {
    await rm(publication.target, { recursive: true, force: true });
    await rename(backup, publication.target);
    await syncDirectory(path.dirname(publication.target));
  } else if (publication.originalPresent) {
    const targetInfo = await lstatOrNull(publication.target);
    if (!targetInfo)
      throw new Error(
        `cannot recover missing original publication: ${publication.target}`,
      );
    const digest = await publicationDigest(publication);
    if (digest !== publication.originalSha256) {
      throw new Error(
        `cannot recover changed original publication: ${publication.target}`,
      );
    }
  } else if (!stagedInfo) {
    await rm(publication.target, { recursive: true, force: true });
    await syncDirectory(path.dirname(publication.target));
  } else if (await lstatOrNull(publication.target)) {
    throw new Error(
      `unexpected target appeared before publication: ${publication.target}`,
    );
  }
  await rm(staged, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
}

async function rollbackCapabilityTransaction(
  transaction: CapabilityTransaction,
): Promise<void> {
  const failures: unknown[] = [];
  for (const publication of [...transaction.journal.publications].reverse()) {
    try {
      await rollbackPublication(transaction, publication);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `capability transaction rollback failed: ${transaction.id}`,
    );
  await rm(transaction.directory, { recursive: true, force: true });
  await syncDirectory(path.dirname(transaction.directory));
}

function assertJournal(
  state: SharedState,
  directory: string,
  value: unknown,
): CapabilityTransactionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid capability transaction journal: ${directory}`);
  const journal = value as Partial<CapabilityTransactionJournal>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.id !== "string" ||
    journal.id !== path.basename(directory) ||
    (journal.operation !== "capability-install" &&
      journal.operation !== "identity-activation") ||
    !new Set(["staging", "prepared", "committed"]).has(journal.status ?? "") ||
    journal.stateRoot !== path.resolve(state.stateDir) ||
    !Array.isArray(journal.publications)
  ) {
    throw new Error(`invalid capability transaction journal: ${directory}`);
  }
  for (const item of journal.publications) {
    if (
      !item ||
      !new Set<PublicationKind>(["file", "directory"]).has(item.kind) ||
      !new Set<CapabilityPublicationBoundary>([
        "store",
        "target",
        "installs",
        "packages",
        "capabilities-view",
        "provenance",
      ]).has(item.boundary) ||
      typeof item.target !== "string" ||
      typeof item.staged !== "string" ||
      typeof item.backup !== "string" ||
      typeof item.originalPresent !== "boolean" ||
      (item.originalSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(item.originalSha256))
    ) {
      throw new Error(
        `invalid capability transaction publication: ${directory}`,
      );
    }
    assertWithinState(state, item.target);
    for (const relative of [item.staged, item.backup]) {
      const resolved = path.resolve(directory, relative);
      if (
        path.relative(directory, resolved).startsWith("..") ||
        path.isAbsolute(path.relative(directory, resolved))
      ) {
        throw new Error(
          `capability transaction path escapes journal: ${relative}`,
        );
      }
    }
  }
  return journal as CapabilityTransactionJournal;
}

async function recoverCapabilityTransactions(
  state: SharedState,
): Promise<void> {
  const root = transactionRoot(state);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = (await readdir(root, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`invalid capability transaction entry: ${entry.name}`);
    const directory = path.join(root, entry.name);
    const journalFile = path.join(directory, "journal.json");
    const parsed = JSON.parse(await readFile(journalFile, "utf8")) as unknown;
    const journal = assertJournal(state, directory, parsed);
    const transaction: CapabilityTransaction = {
      id: journal.id,
      directory,
      journalFile,
      journal,
    };
    if (journal.status === "committed" || journal.status === "staging") {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    await rollbackCapabilityTransaction(transaction);
  }
  await syncDirectory(root);
}

async function publishCapabilityTransaction(
  transaction: CapabilityTransaction,
  hooks: CapabilityTransactionHooks | undefined,
): Promise<void> {
  transaction.journal.status = "prepared";
  await writeTransactionJournal(transaction);
  let committed = false;
  try {
    for (const publication of transaction.journal.publications) {
      await assertOriginalUnchanged(publication);
      const { staged, backup } = absolutePublicationPaths(
        transaction,
        publication,
      );
      if (publication.originalPresent) await rename(publication.target, backup);
      await rename(staged, publication.target);
      await Promise.all([
        syncDirectory(path.dirname(publication.target)),
        syncDirectory(path.dirname(backup)),
      ]);
      await hooks?.afterPublish?.(publication.boundary);
    }
    transaction.journal.status = "committed";
    await writeTransactionJournal(transaction);
    committed = true;
  } catch (error) {
    try {
      await rollbackCapabilityTransaction(transaction);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `capability transaction failed and requires recovery: ${transaction.id}`,
      );
    }
    throw error;
  }
  if (committed) {
    await rm(transaction.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await syncDirectory(path.dirname(transaction.directory)).catch(
      () => undefined,
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeAbandonedMaterializations(
  state: SharedState,
): Promise<void> {
  const temporaryRoot = path.join(stateV2Paths(state).runtimeDir, "tmp");
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^capability-source-(\d+)-[a-f0-9-]+$/.exec(entry.name);
    if (
      !match ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      processIsAlive(Number(match[1]))
    )
      continue;
    await rm(path.join(temporaryRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function withCapabilityLock<T>(
  state: SharedState,
  operation: () => Promise<T>,
): Promise<T> {
  const lockFile = path.join(
    stateV2Paths(state).runtimeDir,
    "locks",
    "capabilities.lock",
  );
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.sync();
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await readFile(lockFile, "utf8")) as {
          pid?: number;
        };
        if (!processIsAlive(lock.pid ?? 0)) {
          await unlink(lockFile);
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for capability lock: ${lockFile}`);
      await Bun.sleep(25);
    }
  }

  try {
    await recoverCapabilityTransactions(state);
    await removeAbandonedMaterializations(state);
    return await operation();
  } finally {
    await unlink(lockFile).catch(() => undefined);
  }
}

function upsertInstallRecord(
  installs: InstallRecord[],
  record: InstallRecord,
): InstallRecord[] {
  const existing = installs.find(
    (item) => item.kind === record.kind && item.name === record.name,
  );
  const next = installs.filter(
    (item) => !(item.kind === record.kind && item.name === record.name),
  );
  next.push(
    existing?.sha256 === record.sha256
      ? { ...record, installedAt: existing.installedAt }
      : record,
  );
  return next.sort((left, right) =>
    `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`),
  );
}

async function capabilitiesViewContent(
  installs: InstallRecord[],
  stagedSkills: ReadonlyMap<
    string,
    { root: string; sha256: string }
  > = new Map(),
): Promise<string> {
  const skills: Array<{ name: string; description: string; sha256: string }> =
    [];
  for (const record of installs.filter((item) => item.kind === "skill")) {
    const staged = stagedSkills.get(record.name);
    const skillRoot = staged?.root ?? record.path;
    const skillFile = path.join(skillRoot, "SKILL.md");
    const metadata = parseSkillFrontmatter(
      await readFile(skillFile, "utf8"),
      skillFile,
    );
    const actual = await inspectTree(skillRoot);
    if (actual.sha256 !== record.sha256)
      throw new Error(
        `installed capability checksum mismatch: ${record.kind}/${record.name}`,
      );
    if (staged && staged.sha256 !== actual.sha256)
      throw new Error(
        `staged capability checksum mismatch: ${record.kind}/${record.name}`,
      );
    skills.push({
      name: metadata.name,
      description: metadata.description,
      sha256: actual.sha256,
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return `${[
    "<!-- Generated from installs.json. Do not edit directly. -->",
    "# Canonical capabilities",
    "",
    ...(skills.length === 0
      ? ["No shared skills are installed."]
      : skills.flatMap((skill) => [
          `## ${skill.name}`,
          "",
          skill.description,
          "",
          `SHA-256: \`${skill.sha256}\``,
          "",
        ])),
  ]
    .join("\n")
    .trimEnd()}\n`;
}

export async function renderCapabilitiesView(
  state: SharedState,
): Promise<string> {
  const content = await capabilitiesViewContent(await readInstalls(state));
  await writeTextIfChanged(
    path.join(stateV2Paths(state).identityDir, "capabilities.md"),
    content,
  );
  return content;
}

export async function inspectCapabilityIntegrity(
  state: SharedState,
): Promise<CapabilityIntegrityInspection> {
  const issues: string[] = [];
  let installs: InstallRecord[] = [];
  let storeObjects = 0;
  let identitySha256: string | null = null;
  try {
    installs = await readInstalls(state);
    if (!Array.isArray(installs)) throw new Error("installs.json must contain an array");
    const keys = new Set<string>();
    for (const record of installs) {
      const key = `${record.kind}/${record.name}`;
      if (keys.has(key)) throw new Error(`duplicate capability install record: ${key}`);
      keys.add(key);
      assertKind(record.kind);
      assertName(record.name);
      if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`invalid capability digest: ${key}`);
      const expectedTarget = path.join(targetBase(state, record.kind), record.name);
      if (path.resolve(record.path) !== path.resolve(expectedTarget)) {
        throw new Error(`capability install path is not canonical: ${key}`);
      }
      const targetTree = await inspectTree(expectedTarget);
      if (targetTree.sha256 !== record.sha256) throw new Error(`installed capability checksum mismatch: ${key}`);
      const storePath = path.join(stateV2Paths(state).capabilityStoreDir, record.sha256);
      const storeTree = await inspectTree(storePath);
      if (storeTree.sha256 !== record.sha256) throw new Error(`capability store checksum mismatch: ${key}`);
    }
    const storeRoot = stateV2Paths(state).capabilityStoreDir;
    const storeEntries = (await readdir(storeRoot, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of storeEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new Error(`invalid capability store entry: ${entry.name}`);
      }
      const tree = await inspectTree(path.join(storeRoot, entry.name));
      if (tree.sha256 !== entry.name) throw new Error(`corrupt capability store object: ${entry.name}`);
    }
    storeObjects = storeEntries.length;

    const expectedView = await capabilitiesViewContent(installs);
    const viewPath = path.join(stateV2Paths(state).identityDir, "capabilities.md");
    const viewInfo = await lstat(viewPath);
    if (!viewInfo.isFile() || viewInfo.isSymbolicLink()) throw new Error("canonical capabilities view must be a physical file");
    if ((await readFile(viewPath, "utf8")) !== expectedView) throw new Error("canonical capabilities view does not match installs.json");

    const identityRoot = stateV2Paths(state).identityDir;
    const identityTree = await inspectTree(identityRoot);
    identitySha256 = identitySelection(identityTree).sha256;
    const identityStore = path.join(stateV2Paths(state).capabilityStoreDir, identitySha256);
    if ((await inspectTree(identityStore)).sha256 !== identitySha256) throw new Error("canonical identity store object is corrupt");
    const agent = JSON.parse(await readFile(path.join(identityRoot, "agent.json"), "utf8")) as Record<string, unknown>;
    if (agent.schemaVersion !== 1 || agent.id !== "rommie" || agent.kind !== "personal-agent") {
      throw new Error("canonical identity agent.json is invalid");
    }
    const identityProvenance = path.join(
      stateV2Paths(state).migrationsDir,
      `identity-rommie-${identitySha256}`,
      "manifest.json",
    );
    const provenance = JSON.parse(await readFile(identityProvenance, "utf8")) as Record<string, unknown>;
    if (
      provenance.schemaVersion !== 1 ||
      provenance.kind !== "identity-activation" ||
      provenance.agentId !== "rommie" ||
      provenance.sourceSha256 !== identitySha256 ||
      path.resolve(String(provenance.target)) !== path.resolve(identityRoot)
    ) {
      throw new Error("canonical identity activation provenance is invalid");
    }

    const transactionDirectory = transactionRoot(state);
    const transactionInfo = await lstatOrNull(transactionDirectory);
    if (transactionInfo) {
      if (!transactionInfo.isDirectory() || transactionInfo.isSymbolicLink()) {
        throw new Error("capability transaction root must be a physical directory");
      }
      const pending = await readdir(transactionDirectory);
      if (pending.length > 0) throw new Error(`unrecovered capability transaction(s): ${pending.sort().join(", ")}`);
    }
  } catch (error) {
    issues.push((error as Error).message);
  }
  return { ok: issues.length === 0, installs: installs.length, storeObjects, identitySha256, issues };
}

function upsertPackageRecord(
  registrations: PackageRegistration[],
  manifest: AgentsPackageManifest | null,
  record: InstallRecord,
  now: string,
): PackageRegistration[] {
  const collision = manifest
    ? registrations.find(
        (item) => item.id === manifest.id && item.path !== record.path,
      )
    : undefined;
  if (collision) {
    throw new Error(
      `package id ${manifest?.id} is already registered at ${collision.path}`,
    );
  }
  const existing = registrations.find((item) => item.path === record.path);
  const next = registrations.filter(
    (item) =>
      item.path !== record.path && (!manifest || item.id !== manifest.id),
  );
  if (manifest) {
    const candidate: PackageRegistration = {
      id: manifest.id,
      kind: manifest.kind,
      source: record.source,
      path: record.path,
      manifestPath: path.join(record.path, "agent.package.json"),
      registeredAt: now,
    };
    const unchanged =
      existing &&
      existing.id === candidate.id &&
      existing.kind === candidate.kind &&
      existing.source === candidate.source &&
      existing.path === candidate.path &&
      existing.manifestPath === candidate.manifestPath;
    next.push(
      unchanged
        ? { ...candidate, registeredAt: existing.registeredAt }
        : candidate,
    );
  }
  return next.sort((left, right) => left.id.localeCompare(right.id));
}

async function prepareProvenancePublication(
  state: SharedState,
  transaction: CapabilityTransaction,
  directoryName: string,
  manifest: Record<string, unknown>,
): Promise<PreparedPublication | null> {
  const target = path.join(stateV2Paths(state).migrationsDir, directoryName);
  const existing = await lstatOrNull(target);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error(
        `provenance target is not a physical directory: ${target}`,
      );
    const names = (await readdir(target)).sort();
    if (JSON.stringify(names) !== JSON.stringify(["manifest.json"])) {
      throw new Error(`provenance directory has unexpected content: ${target}`);
    }
    const current = JSON.parse(
      await readFile(path.join(target, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const currentKeys = Object.keys(current).sort();
    const expectedKeys = Object.keys(manifest).sort();
    if (JSON.stringify(currentKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(
        `immutable provenance does not match transaction: ${target}`,
      );
    }
    for (const [key, expected] of Object.entries(manifest)) {
      if (key === "activatedAt" || key === "installedAt") {
        if (
          typeof current[key] !== "string" ||
          !Number.isFinite(Date.parse(current[key] as string))
        ) {
          throw new Error(
            `immutable provenance has an invalid ${key}: ${target}`,
          );
        }
      } else if (JSON.stringify(current[key]) !== JSON.stringify(expected)) {
        throw new Error(
          `immutable provenance does not match transaction: ${target}`,
        );
      }
    }
    return null;
  }
  return prepareDirectoryPublication(
    state,
    transaction,
    "provenance",
    target,
    async (staged) => {
      await mkdir(staged, { recursive: false, mode: 0o700 });
      await writeTextAtomic(path.join(staged, "manifest.json"), content, 0o600);
    },
  );
}

async function validateIdentityBundle(root: string): Promise<ValidatedTree> {
  const tree = await inspectTree(root);
  const topLevel = new Set(
    tree.entries.map((entry) => entry.relativePath.split("/")[0]),
  );
  for (const name of topLevel) {
    if (!new Set(["persona.md", "roles", "prompts"]).has(name)) {
      throw new Error(`identity bundle contains unsupported entry: ${name}`);
    }
  }
  const personaPath = path.join(root, "persona.md");
  if (!(await exists(personaPath)))
    throw new Error("identity bundle requires persona.md");
  const persona = await readFile(personaPath, "utf8");
  if (!persona.startsWith("# Rommie\n"))
    throw new Error("identity persona must begin with '# Rommie'");

  const rolesDir = path.join(root, "roles");
  const promptsDir = path.join(root, "prompts");
  if (!(await exists(rolesDir)) || !(await exists(promptsDir))) {
    throw new Error("identity bundle requires roles/ and prompts/");
  }
  const roleFiles = (await readdir(rolesDir))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const promptFiles = (await readdir(promptsDir))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const roleIds = roleFiles.map((name) => name.slice(0, -5));
  const promptIds = promptFiles.map((name) => name.slice(0, -3));
  if (
    roleIds.length === 0 ||
    JSON.stringify(roleIds) !== JSON.stringify(promptIds)
  ) {
    throw new Error(
      "identity bundle must contain matching non-empty role and prompt sets",
    );
  }
  for (const id of roleIds) {
    assertName(id);
    const role = await readFile(path.join(rolesDir, `${id}.yaml`), "utf8");
    const name = /^name:\s*([^\s#]+)\s*$/m.exec(role)?.[1];
    const scope = /^scope:\s*([^\s#]+)\s*$/m.exec(role)?.[1];
    const type = /^type:\s*([^\s#]+)\s*$/m.exec(role)?.[1];
    if (
      name !== id ||
      scope !== "worker" ||
      !new Set(["on-demand", "background"]).has(type ?? "")
    ) {
      throw new Error(`invalid worker role manifest: ${id}.yaml`);
    }
    if (!(await readFile(path.join(promptsDir, `${id}.md`), "utf8")).trim()) {
      throw new Error(`empty role prompt: ${id}.md`);
    }
  }
  return tree;
}

function identitySelection(tree: ValidatedTree): ValidatedTree {
  const entries = tree.entries.filter(
    (entry) =>
      entry.relativePath === "persona.md" ||
      entry.relativePath === "roles" ||
      entry.relativePath.startsWith("roles/") ||
      entry.relativePath === "prompts" ||
      entry.relativePath.startsWith("prompts/"),
  );
  return { entries, sha256: digestEntries(entries) };
}

export async function activateIdentityBundle(
  state: SharedState,
  source: string,
  options: {
    replace?: boolean;
    now?: Date;
    transactionHooks?: CapabilityTransactionHooks;
  } = {},
): Promise<IdentityActivationResult> {
  const materialized = await materializeSource(state, source);
  try {
    const sourceTree = await validateIdentityBundle(materialized.root);
    return await withCapabilityLock(state, async () => {
      const identityDir = stateV2Paths(state).identityDir;
      const currentTree = await inspectTree(identityDir);
      const identityChanged =
        identitySelection(currentTree).sha256 !== sourceTree.sha256;
      if (identityChanged && !options.replace) {
        throw new Error(
          `canonical identity has different content: ${identityDir}; pass --replace for deliberate replacement`,
        );
      }

      const transaction = await beginCapabilityTransaction(
        state,
        "identity-activation",
      );
      try {
        await prepareStorePublication(
          state,
          transaction,
          materialized.root,
          sourceTree,
        );

        if (identityChanged) {
          await prepareDirectoryPublication(
            state,
            transaction,
            "target",
            identityDir,
            async (staged) => {
              await cp(identityDir, staged, {
                recursive: true,
                preserveTimestamps: true,
              });
              await rm(path.join(staged, "persona.md"), { force: true });
              await rm(path.join(staged, "roles"), {
                recursive: true,
                force: true,
              });
              await rm(path.join(staged, "prompts"), {
                recursive: true,
                force: true,
              });
              await cp(
                path.join(materialized.root, "persona.md"),
                path.join(staged, "persona.md"),
                { preserveTimestamps: true },
              );
              await cp(
                path.join(materialized.root, "roles"),
                path.join(staged, "roles"),
                { recursive: true, preserveTimestamps: true },
              );
              await cp(
                path.join(materialized.root, "prompts"),
                path.join(staged, "prompts"),
                {
                  recursive: true,
                  preserveTimestamps: true,
                },
              );
              const stagedTree = await inspectTree(staged);
              if (identitySelection(stagedTree).sha256 !== sourceTree.sha256) {
                throw new Error("identity changed while staging activation");
              }
              await normalizeModes(staged, stagedTree.entries);
            },
          );
        }

        const activatedAt = (options.now ?? new Date()).toISOString();
        await prepareProvenancePublication(
          state,
          transaction,
          `identity-rommie-${sourceTree.sha256}`,
          {
            schemaVersion: 1,
            kind: "identity-activation",
            agentId: "rommie",
            source,
            sourceSha256: sourceTree.sha256,
            target: identityDir,
            activatedAt,
          },
        );

        const changed = transaction.journal.publications.length > 0;
        if (changed)
          await publishCapabilityTransaction(
            transaction,
            options.transactionHooks,
          );
        else await rm(transaction.directory, { recursive: true, force: true });
        return { sha256: sourceTree.sha256, changed, path: identityDir };
      } catch (error) {
        if (transaction.journal.status === "staging") {
          await rm(transaction.directory, { recursive: true, force: true });
        }
        throw error;
      }
    });
  } finally {
    await materialized.cleanup();
  }
}

export async function installCapability(
  state: SharedState,
  options: CapabilityInstallOptions,
): Promise<CapabilityInstallResult> {
  assertKind(options.kind);
  assertName(options.name);
  const materialized = await materializeSource(state, options.source);
  try {
    const sourceTree = await validatePayload(
      materialized.root,
      options.kind,
      options.name,
    );
    return await withCapabilityLock(state, async () => {
      const base = assertWithinState(state, targetBase(state, options.kind));
      const target = assertWithinState(state, path.join(base, options.name));
      const targetRelative = path.relative(base, target);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative))
        throw new Error(`install target escapes state root: ${target}`);

      let currentHash: string | null = null;
      if (await exists(target)) {
        const targetInfo = await lstat(target);
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
          throw new Error(
            `install target is not a physical directory: ${target}`,
          );
        currentHash = (await inspectTree(target)).sha256;
      }

      if (
        currentHash !== null &&
        currentHash !== sourceTree.sha256 &&
        !options.replace
      ) {
        throw new Error(
          `installed capability has different content: ${target}; pass --replace for deliberate replacement`,
        );
      }

      const installs = await readInstalls(state);
      const existingRecord = installs.find(
        (item) => item.kind === options.kind && item.name === options.name,
      );
      const candidate: InstallRecord = {
        name: options.name,
        kind: options.kind,
        source: options.source,
        path: target,
        sha256: sourceTree.sha256,
        installedAt:
          existingRecord?.sha256 === sourceTree.sha256
            ? existingRecord.installedAt
            : (options.now ?? new Date()).toISOString(),
      };
      const record =
        existingRecord &&
        existingRecord.path === candidate.path &&
        existingRecord.sha256 === candidate.sha256
          ? existingRecord
          : candidate;
      const nextInstalls = upsertInstallRecord(installs, record);
      const manifest = await readPackageManifest(materialized.root);
      const registeredAt = (options.now ?? new Date()).toISOString();
      const nextPackages = upsertPackageRecord(
        await readPackageRegistrations(state),
        manifest,
        record,
        registeredAt,
      );
      const stagedSkills =
        options.kind === "skill"
          ? new Map([
              [
                options.name,
                { root: materialized.root, sha256: sourceTree.sha256 },
              ],
            ])
          : new Map<string, { root: string; sha256: string }>();
      const capabilitiesView = await capabilitiesViewContent(
        nextInstalls,
        stagedSkills,
      );

      const transaction = await beginCapabilityTransaction(
        state,
        "capability-install",
      );
      try {
        await prepareStorePublication(
          state,
          transaction,
          materialized.root,
          sourceTree,
        );
        if (currentHash !== sourceTree.sha256) {
          await prepareTreeCopyPublication(
            state,
            transaction,
            "target",
            target,
            materialized.root,
            sourceTree,
          );
        }
        await prepareFilePublication(
          state,
          transaction,
          "installs",
          state.installsFile,
          `${JSON.stringify(nextInstalls, null, 2)}\n`,
        );
        await prepareFilePublication(
          state,
          transaction,
          "packages",
          state.packagesFile,
          `${JSON.stringify(nextPackages, null, 2)}\n`,
        );
        await prepareFilePublication(
          state,
          transaction,
          "capabilities-view",
          path.join(stateV2Paths(state).identityDir, "capabilities.md"),
          capabilitiesView,
        );
        await prepareProvenancePublication(
          state,
          transaction,
          `capability-${options.kind}-${options.name}-${sourceTree.sha256}`,
          {
            schemaVersion: 1,
            kind: "capability-installation",
            capabilityKind: options.kind,
            name: options.name,
            source: record.source,
            sourceSha256: sourceTree.sha256,
            target,
            installedAt: record.installedAt,
          },
        );

        const changed = transaction.journal.publications.length > 0;
        if (changed)
          await publishCapabilityTransaction(
            transaction,
            options.transactionHooks,
          );
        else await rm(transaction.directory, { recursive: true, force: true });
        return {
          record,
          changed,
          replaced: currentHash !== null && currentHash !== sourceTree.sha256,
        };
      } catch (error) {
        if (transaction.journal.status === "staging") {
          await rm(transaction.directory, { recursive: true, force: true });
        }
        throw error;
      }
    });
  } finally {
    await materialized.cleanup();
  }
}
