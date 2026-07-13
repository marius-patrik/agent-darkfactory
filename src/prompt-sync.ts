import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROMPT_MANIFEST_PATH,
  computeChecksum,
  composePrompt,
  defaultPromptsRoot,
  loadFixture,
  loadManifest,
  publishPromptLibraryManifestLast,
  readLibraryText,
  recoverPromptManifestIfNeeded,
  validatePromptLibraryLayout,
  verifySnapshots,
  writePinnedLibraryFile,
  type PromptManifest
} from "./prompts.js";

export interface PromptLibrarySyncContext {
  liveRoot: string;
  stageRoot: string;
}

export interface PromptLibrarySyncOps {
  /** Test seam that holds the OS-owned lock without touching filesystem state. */
  afterLock?: (liveRoot: string) => void | Promise<void>;
  /** Test seam for deterministic copy-boundary disagreement cases. */
  afterCopy?: (context: PromptLibrarySyncContext) => void;
}

export interface PromptLibrarySyncResult {
  artifactCount: number;
  fixtureCount: number;
  root: string;
}

type PromptLibrarySourceHashes = ReadonlyMap<string, string>;

interface SyncLockEndpoint {
  address: string | { host: string; port: number; exclusive: true };
  label: string;
}

interface SyncLockHandle {
  server: Server;
  identity: string;
}

const GLOBAL_SYNC_LOCK_NAME = "darkfactory-prompt-sync-global-v1";

function promptRootIdentity(root: string): string {
  const admitted = statSync(root, { bigint: true });
  // dev + ino is the volume/device and stable file ID. Unlike path text, this
  // is identical for direct, UNC, mapped-drive, symlink, and case aliases that
  // reach the same directory. A filesystem reporting a coarse/zero identity
  // may create conservative false contention, but can never split one root
  // across multiple locks.
  return `${process.platform}:${admitted.dev}:${admitted.ino}`;
}

function syncLockEndpoint(): SyncLockEndpoint {
  if (process.platform === "win32") {
    const pipe = `\\\\.\\pipe\\${GLOBAL_SYNC_LOCK_NAME}`;
    return { address: pipe, label: pipe };
  }
  if (process.platform === "linux") {
    return {
      address: `\0${GLOBAL_SYNC_LOCK_NAME}`,
      label: `abstract:${GLOBAL_SYNC_LOCK_NAME}`
    };
  }
  // Platforms without abstract sockets use one collision-resistant loopback
  // endpoint for the intentionally global lock. The unusual 127/8 address and
  // unprivileged port are derived from the versioned lock name.
  const digest = createHash("sha256").update(GLOBAL_SYNC_LOCK_NAME).digest();
  const host = `127.${digest[0]}.${digest[1]}.${digest[2]}`;
  const port = 1024 + (digest.readUInt16BE(3) % 64512);
  return {
    address: { host, port, exclusive: true },
    label: `${host}:${port}`
  };
}

async function acquireEndpoint(endpoint: SyncLockEndpoint): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveLock, rejectLock) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      rejectLock(
        new Error(
          `Prompt-library sync lock unavailable at ${endpoint.label}; ` +
            `another sync is active or the deterministic endpoint is unavailable (${error.code ?? error.message})`
        )
      );
    };
    server.once("error", onError);
    const onListening = (): void => {
      server.off("error", onError);
      // Keep an error listener installed so a late listener error cannot become
      // an unhandled process exception while the lock is held.
      server.on("error", () => undefined);
      resolveLock();
    };
    if (typeof endpoint.address === "string") {
      server.listen(endpoint.address, onListening);
    } else {
      server.listen(endpoint.address, onListening);
    }
  });
  return server;
}

async function releaseEndpoint(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function acquireSyncLock(root: string): Promise<SyncLockHandle> {
  // One process-owned endpoint serializes every prompt-library sync on the
  // machine. This conservative scope cannot be split by path aliases or by a
  // root being replaced after admission.
  const server = await acquireEndpoint(syncLockEndpoint());
  try {
    return { server, identity: promptRootIdentity(root) };
  } catch (error) {
    try {
      await releaseEndpoint(server);
    } catch {
      // Preserve the original admission failure.
    }
    throw error;
  }
}

function assertLockedRootIdentity(root: string, lock: SyncLockHandle): void {
  if (promptRootIdentity(root) !== lock.identity) {
    throw new Error("Prompt-library root changed after sync-lock admission");
  }
}

async function releaseSyncLock(lock: SyncLockHandle): Promise<void> {
  await releaseEndpoint(lock.server);
}

function sourcePaths(manifest: PromptManifest): string[] {
  return [
    PROMPT_MANIFEST_PATH,
    ...manifest.artifacts.map((artifact) => artifact.path),
    ...manifest.fixtures.map((fixture) => fixture.path)
  ].sort();
}

/** Capture the immutable, manifest-controlled source set (derived snapshots are outputs). */
function captureSourceHashes(root: string, manifest: PromptManifest): PromptLibrarySourceHashes {
  return new Map(
    sourcePaths(manifest).map((relativePath) => [
      relativePath,
      computeChecksum(readLibraryText(root, relativePath))
    ])
  );
}

/**
 * The completed isolated copy is authoritative. Live must expose the exact
 * same manifest-controlled paths and contents at every publication boundary.
 */
function assertSourcesMatch(root: string, expected: PromptLibrarySourceHashes): void {
  const liveManifest = loadManifest(root);
  const actual = captureSourceHashes(root, liveManifest);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  const missing = expectedPaths.filter((relativePath) => !actual.has(relativePath));
  const unexpected = actualPaths.filter((relativePath) => !expected.has(relativePath));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Prompt-library live source set does not match isolated stage` +
        `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}` +
        `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""}`
    );
  }

  for (const relativePath of expectedPaths) {
    if (actual.get(relativePath) !== expected.get(relativePath)) {
      throw new Error(
        `Prompt-library live source does not match isolated stage: ${relativePath}`
      );
    }
  }
}

/**
 * Regenerate in an isolated copy, verify it there, then pin every pre-existing
 * live destination, write derived snapshots through retained handles, and
 * write the live manifest handle last.
 */
export async function syncPromptLibrary(
  root: string = defaultPromptsRoot(),
  ops: PromptLibrarySyncOps = {}
): Promise<PromptLibrarySyncResult> {
  const liveRoot = realpathSync(resolve(root));
  const lock = await acquireSyncLock(liveRoot);
  const assertLiveRoot = (): void => assertLockedRootIdentity(liveRoot, lock);
  let stageParent: string | undefined;

  try {
    await ops.afterLock?.(liveRoot);
    assertLiveRoot();
    stageParent = mkdtempSync(join(tmpdir(), "df-prompts-sync-"));
    const stageRoot = join(stageParent, "prompts");
    recoverPromptManifestIfNeeded(liveRoot);
    const liveManifest = loadManifest(liveRoot);
    validatePromptLibraryLayout(liveRoot, liveManifest);

    cpSync(liveRoot, stageRoot, { recursive: true, dereference: false });
    assertLiveRoot();
    ops.afterCopy?.({ liveRoot, stageRoot });

    const manifest = loadManifest(stageRoot);
    validatePromptLibraryLayout(stageRoot, manifest);

    // Capture from the completed copy before sync mutates checksums or snapshots.
    // This closes the copy/ABA gap where a mixed stage could otherwise be
    // admitted by comparing live only with a pre-copy live hash set.
    const stagedSourceHashes = captureSourceHashes(stageRoot, manifest);
    assertLiveRoot();
    assertSourcesMatch(liveRoot, stagedSourceHashes);

    for (const artifact of manifest.artifacts) {
      artifact.checksum = computeChecksum(readLibraryText(stageRoot, artifact.path));
    }
    for (const fixture of manifest.fixtures) {
      fixture.checksum = computeChecksum(readLibraryText(stageRoot, fixture.path));
      fixture.snapshotChecksum = computeChecksum(readLibraryText(stageRoot, fixture.snapshot));
    }
    writePinnedLibraryFile(stageRoot, PROMPT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    const snapshotWrites = manifest.fixtures.map((fixture) => {
      const content = composePrompt(loadFixture(stageRoot, fixture.path), stageRoot);
      fixture.snapshotChecksum = computeChecksum(content);
      return { relativePath: fixture.snapshot, content };
    });
    const manifestWrite = {
      relativePath: PROMPT_MANIFEST_PATH,
      content: `${JSON.stringify(manifest, null, 2)}\n`
    };
    publishPromptLibraryManifestLast(stageRoot, snapshotWrites, manifestWrite);
    verifySnapshots(stageRoot);

    const finalManifest = loadManifest(stageRoot);
    const liveSnapshotWrites = finalManifest.fixtures.map((fixture) => ({
      relativePath: fixture.snapshot,
      content: readLibraryText(stageRoot, fixture.snapshot)
    }));
    const liveManifestWrite = {
      relativePath: PROMPT_MANIFEST_PATH,
      content: readLibraryText(stageRoot, PROMPT_MANIFEST_PATH)
    };
    publishPromptLibraryManifestLast(liveRoot, liveSnapshotWrites, liveManifestWrite, {
      beforeCommit: () => {
        assertLiveRoot();
        assertSourcesMatch(liveRoot, stagedSourceHashes);
      },
      beforeManifest: () => {
        assertLiveRoot();
        assertSourcesMatch(liveRoot, stagedSourceHashes);
      }
    });

    assertLiveRoot();
    verifySnapshots(liveRoot);
    return {
      artifactCount: finalManifest.artifacts.length,
      fixtureCount: finalManifest.fixtures.length,
      root: liveRoot
    };
  } finally {
    try {
      if (stageParent !== undefined) {
        rmSync(stageParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    } finally {
      await releaseSyncLock(lock);
    }
  }
}
