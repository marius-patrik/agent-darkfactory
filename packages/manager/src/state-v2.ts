import path from "node:path";
import { chmod, link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SharedState } from "./state";

export const STATE_SCHEMA_VERSION = 2 as const;

export interface AgentStateManifest {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  installId: string;
  machineId: string;
  agentId: "rommie";
  createdAt: string;
}

export interface StateV2Paths {
  manifestFile: string;
  identityDir: string;
  memoryDir: string;
  memoryEventsDir: string;
  memoryRecordsDir: string;
  memoryViewsDir: string;
  runtimeDir: string;
  syncDir: string;
  provenanceDir: string;
  migrationsDir: string;
  quarantineDir: string;
  capabilityStoreDir: string;
  providersFile: string;
}

export function stateV2Paths(state: SharedState): StateV2Paths {
  const memoryDir = path.join(state.stateDir, "memory");
  const provenanceDir = path.join(state.stateDir, "provenance");
  return {
    manifestFile: path.join(state.stateDir, "manifest.json"),
    identityDir: path.join(state.stateDir, "identity"),
    memoryDir,
    memoryEventsDir: path.join(memoryDir, "events"),
    memoryRecordsDir: path.join(memoryDir, "records"),
    memoryViewsDir: path.join(memoryDir, "views"),
    runtimeDir: path.join(state.stateDir, "runtime"),
    syncDir: path.join(state.stateDir, "sync"),
    provenanceDir,
    migrationsDir: path.join(provenanceDir, "migrations"),
    quarantineDir: path.join(state.stateDir, "quarantine"),
    capabilityStoreDir: path.join(state.stateDir, "store", "sha256"),
    providersFile: path.join(state.stateDir, "providers.json"),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

const TRANSIENT_WINDOWS_PUBLICATION_ERRORS = new Set(["EACCES", "EBUSY", "ENOENT", "EPERM"]);
const WINDOWS_PUBLICATION_ATTEMPTS = 10;
const atomicPublicationTails = new Map<string, Promise<void>>();

async function serializeAtomicPublication(filePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = atomicPublicationTails.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  atomicPublicationTails.set(filePath, current);
  try {
    await current;
  } finally {
    if (atomicPublicationTails.get(filePath) === current) atomicPublicationTails.delete(filePath);
  }
}

export async function retryWindowsFileOperation<T>(
  operation: () => Promise<T>,
  platform = process.platform,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<T> {
  if (platform !== "win32") {
    return await operation();
  }
  for (let attempt = 0; attempt < WINDOWS_PUBLICATION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        !TRANSIENT_WINDOWS_PUBLICATION_ERRORS.has(code) ||
        attempt === WINDOWS_PUBLICATION_ATTEMPTS - 1
      ) throw error;
      await wait(Math.min(160, 10 * 2 ** attempt));
    }
  }
  throw new Error("unreachable Windows file-operation retry state");
}

export interface AtomicReplacementOperations {
  platform: NodeJS.Platform;
  rename: typeof rename;
  wait: (milliseconds: number) => Promise<void>;
}

export interface ExclusiveFilePublicationOperations {
  platform: NodeJS.Platform;
  link: typeof link;
  open: typeof open;
  wait: (milliseconds: number) => Promise<void>;
}

async function syncDirectory(
  directory: string,
  openOperation: typeof open = open,
): Promise<void> {
  const directoryHandle = await openOperation(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function publishAtomicReplacement(
  temporary: string,
  filePath: string,
  overrides: Partial<AtomicReplacementOperations> = {},
): Promise<void> {
  const operations: AtomicReplacementOperations = {
    platform: process.platform,
    rename,
    wait: delay,
    ...overrides,
  };
  // Keep replacement as one namespace operation. A destination-to-backup swap
  // would make the prior complete state disappear between two renames.
  await retryWindowsFileOperation(
    () => operations.rename(temporary, filePath),
    operations.platform,
    operations.wait,
  );
}

export async function publishFileExclusive(
  temporary: string,
  filePath: string,
  overrides: Partial<ExclusiveFilePublicationOperations> = {},
): Promise<boolean> {
  const operations: ExclusiveFilePublicationOperations = {
    platform: process.platform,
    link,
    open,
    wait: delay,
    ...overrides,
  };
  try {
    await retryWindowsFileOperation(
      () => operations.link(temporary, filePath),
      operations.platform,
      operations.wait,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    throw error;
  }
  if (operations.platform !== "win32") {
    await syncDirectory(path.dirname(filePath), operations.open);
  }
  return true;
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  mode = 0o600,
  overrides: Partial<AtomicReplacementOperations> = {},
): Promise<void> {
  await serializeAtomicPublication(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await publishAtomicReplacement(temporary, filePath, overrides);
      const platform = overrides.platform ?? process.platform;
      if (platform !== "win32") {
        await chmod(filePath, mode);
        await syncDirectory(path.dirname(filePath));
      }
    } finally {
      await retryWindowsFileOperation(
        () => rm(temporary, { force: true }),
        overrides.platform ?? process.platform,
        overrides.wait ?? delay,
      );
    }
  });
}

export async function writeTextExclusive(
  filePath: string,
  content: string,
  mode = 0o600,
  overrides: Partial<ExclusiveFilePublicationOperations> = {},
): Promise<boolean> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const platform = overrides.platform ?? process.platform;
    if (platform !== "win32") await chmod(temporary, mode);
    const published = await publishFileExclusive(temporary, filePath, overrides);
    if (!published) return false;
    if (platform !== "win32") {
      await chmod(filePath, mode);
    }
    return true;
  } finally {
    await retryWindowsFileOperation(
      () => rm(temporary, { force: true }),
      overrides.platform ?? process.platform,
      overrides.wait ?? delay,
    );
  }
}

export async function writeTextIfChanged(filePath: string, content: string, mode = 0o600): Promise<boolean> {
  if (!(await exists(filePath))) {
    if (await writeTextExclusive(filePath, content, mode)) return true;
  }
  const current = await readFile(filePath, "utf8");
  if (current === content) return false;
  await writeTextAtomic(filePath, content, mode);
  return true;
}

export async function readStateManifest(state: SharedState): Promise<AgentStateManifest | null> {
  const filePath = stateV2Paths(state).manifestFile;
  if (!(await exists(filePath))) return null;
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<AgentStateManifest>;
  if (
    parsed.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof parsed.installId !== "string" ||
    typeof parsed.machineId !== "string" ||
    parsed.agentId !== "rommie" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error(`invalid Agent OS v2 manifest: ${filePath}`);
  }
  return parsed as AgentStateManifest;
}

async function seedJson(filePath: string, value: unknown): Promise<void> {
  await writeTextExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedText(filePath: string, value: string): Promise<void> {
  await writeTextExclusive(filePath, value);
}

export async function ensureStateV2(state: SharedState, now = new Date()): Promise<AgentStateManifest> {
  const paths = stateV2Paths(state);
  const privateDirectories = [
    state.stateDir,
    paths.identityDir,
    path.join(paths.identityDir, "roles"),
    path.join(paths.identityDir, "prompts"),
    path.join(paths.identityDir, "rules"),
    paths.memoryDir,
    paths.memoryEventsDir,
    paths.memoryRecordsDir,
    paths.memoryViewsDir,
    path.join(paths.memoryDir, "snapshots"),
    paths.runtimeDir,
    path.join(paths.runtimeDir, "locks"),
    path.join(paths.runtimeDir, "pids"),
    path.join(paths.runtimeDir, "tmp"),
    path.join(paths.runtimeDir, "cache"),
    path.join(paths.runtimeDir, "logs"),
    paths.syncDir,
    path.join(paths.syncDir, "repo"),
    path.join(paths.syncDir, "outbox"),
    paths.provenanceDir,
    path.join(paths.provenanceDir, "events"),
    paths.migrationsDir,
    paths.quarantineDir,
    paths.capabilityStoreDir,
  ];
  await Promise.all(privateDirectories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  if (process.platform !== "win32") {
    await Promise.all(privateDirectories.map((directory) => chmod(directory, 0o700)));
  }

  let manifest = await readStateManifest(state);
  if (!manifest) {
    const candidate: AgentStateManifest = {
      schemaVersion: STATE_SCHEMA_VERSION,
      installId: randomUUID(),
      machineId: randomUUID(),
      agentId: "rommie",
      createdAt: now.toISOString(),
    };
    if (await writeTextExclusive(paths.manifestFile, `${JSON.stringify(candidate, null, 2)}\n`)) manifest = candidate;
    else manifest = await readStateManifest(state);
    if (!manifest) throw new Error(`canonical manifest creation failed: ${paths.manifestFile}`);
  }

  await seedJson(path.join(paths.identityDir, "agent.json"), {
    schemaVersion: 1,
    id: "rommie",
    kind: "personal-agent",
  });
  await seedText(path.join(paths.identityDir, "persona.md"), "# Rommie\n");
  await seedText(
    path.join(paths.memoryViewsDir, "startup.md"),
    "<!-- Generated projection from immutable canonical memory events. Do not edit directly. -->\n" +
      "# Canonical startup context\n\n" +
      "Agent: rommie\n" +
      "Projection through: none\n\n" +
      "No active non-secret memory records.\n",
  );
  await seedJson(paths.providersFile, { schemaVersion: 1, providers: {} });
  await seedJson(path.join(state.secretsDir, "registry.json"), { schemaVersion: 1, secrets: {} });
  await seedJson(path.join(paths.syncDir, "config.json"), {
    schemaVersion: 2,
    enabled: false,
    transport: null,
  });

  return manifest;
}
