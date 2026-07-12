import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../../src/manager/state";
import { writeSecret } from "../../src/manager/secrets";
import { rebuildMemoryProjections, rememberMemory } from "../../src/manager/memory";
import {
  createSession,
  inspectSessionIntegrity,
  withSessionWriteLock,
  withSessionWriteTransaction,
} from "../../src/harness/session";
import { doctorState } from "../../src/manager/state-doctor";
import { appendOrchestratorLedger, initializeOrchestratorState } from "../../src/manager/orchestrator";
import {
  disableEventSync,
  enableEventSync,
  eventSyncStatus,
  exportEventBundle,
  importEventBundle,
  recoverPreparedEventImports,
} from "../../src/manager/event-sync";

const key = "7b".repeat(32);
const evidence = {
  uri: "test://event-sync",
  contentHash: "a".repeat(64),
  sourceClass: "verified" as const,
  confidence: 1,
};

async function exchangeState(root: string) {
  const state = sharedState(root);
  await ensureSharedState(state);
  await writeSecret(state, "AGENTS_SYNC_KEY", key);
  await enableEventSync(state);
  return state;
}

describe("encrypted cross-machine event exchange", () => {
  test("memory and session authority converge with identical projection hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-converge-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "exchange",
        value: "verified",
        evidence,
        sensitivity: "internal",
      });
      await createSession(source, {
        sessionId: "exchange-session",
        provider: "codex",
        model: "gpt-5",
        mode: "task",
        workdir: "/workspace",
      });

      const bundle = path.join(root, "events.bundle.json");
      const exported = await exportEventBundle(source, bundle);
      let importSettled = false;
      let pendingImport: ReturnType<typeof importEventBundle> | undefined;
      let concurrentAppend: ReturnType<typeof withSessionWriteTransaction> | undefined;
      await withSessionWriteLock(target, "exchange-session", async () => {
        pendingImport = importEventBundle(target, bundle, {
          beforeProjection: async () => {
            let appendSettled = false;
            concurrentAppend = withSessionWriteTransaction(target, "exchange-session", async (transaction) => {
              const turnId = await transaction.beginTurn();
              await transaction.appendMessage(turnId, { role: "user", content: "continued on the second machine" });
              await transaction.completeTurn(turnId);
            });
            void concurrentAppend.finally(() => {
              appendSettled = true;
            });
            await Bun.sleep(75);
            expect(appendSettled).toBe(false);
          },
        });
        void pendingImport.finally(() => {
          importSettled = true;
        });
        await rebuildMemoryProjections(target);
        await Bun.sleep(75);
        expect(importSettled).toBe(false);
      });
      const imported = await pendingImport!;

      expect(imported.imported).toBe(2);
      expect(imported.projectionHash).toBe(exported.projectionHash);
      await concurrentAppend!;
      expect((await inspectSessionIntegrity(target)).ok).toBe(true);
      expect(await eventSyncStatus(target)).toMatchObject({ committedImports: 1, preparedImports: 0 });

      await rememberMemory(target, {
        scope: "project",
        subject: "Andromeda",
        predicate: "reverse-exchange",
        value: "verified",
        evidence,
      });
      const reverseBundle = path.join(root, "events.reverse.bundle.json");
      const reverseExport = await exportEventBundle(target, reverseBundle);
      const reverseImport = await importEventBundle(source, reverseBundle);
      expect(reverseImport.imported).toBe(4);
      expect(reverseImport.projectionHash).toBe(reverseExport.projectionHash);
      expect((await inspectSessionIntegrity(source)).ok).toBe(true);
      expect((await doctorState(source)).checks.find((check) => check.id === "sync_safety")?.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupted imports recover and replayed bundles are idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-recovery-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "journal",
        value: "prepared-then-committed",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);

      await expect(importEventBundle(target, bundle, { failAfter: 1 })).rejects.toThrow("simulated interrupted");
      expect(await eventSyncStatus(target)).toMatchObject({ committedImports: 0, preparedImports: 1 });
      const [preparedJournalName] = await readdir(path.join(target.stateDir, "sync", "imports"));
      const preparedJournal = JSON.parse(
        await readFile(path.join(target.stateDir, "sync", "imports", preparedJournalName), "utf8"),
      ) as Record<string, unknown>;
      expect(preparedJournal.entries).toBeUndefined();
      expect(Array.isArray(preparedJournal.entryHashes)).toBe(true);
      expect((await doctorState(target)).checks.find((check) => check.id === "sync_safety")?.ok).toBe(false);
      await disableEventSync(target);
      expect((await doctorState(target)).checks.find((check) => check.id === "sync_safety")?.ok).toBe(false);
      await enableEventSync(target);
      await rm(bundle);
      const [recovered] = await recoverPreparedEventImports(target);
      expect(recovered.projectionHash).toBeTruthy();
      expect(await eventSyncStatus(target)).toMatchObject({ committedImports: 1, preparedImports: 0 });
      const replayBundle = path.join(root, "events.replay.bundle.json");
      await exportEventBundle(source, replayBundle);
      const replayed = await importEventBundle(target, replayBundle);
      expect(replayed).toMatchObject({ idempotent: true, imported: 0, skipped: 1 });
      await writeFile(
        path.join(target.stateDir, "sync", "config.json"),
        `${JSON.stringify({ schemaVersion: 2, enabled: false, transport: 123 })}\n`,
      );
      expect((await doctorState(target)).checks.find((check) => check.id === "sync_safety")?.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("export convergence hash is derived only from the captured event snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-export-snapshot-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "snapshot-first",
        value: "first",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      const exported = await exportEventBundle(source, bundle, {
        afterCollection: async () => {
          await rememberMemory(source, {
            scope: "project",
            subject: "Andromeda",
            predicate: "snapshot-later",
            value: "second",
            evidence,
          });
        },
      });
      const imported = await importEventBundle(target, bundle);
      expect(imported.imported).toBe(1);
      expect(imported.projectionHash).toBe(exported.projectionHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prepared recovery reauthenticates its durable encrypted envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-recovery-auth-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "recovery-auth",
        value: "required",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);
      await expect(importEventBundle(target, bundle, { failAfter: 1 })).rejects.toThrow("simulated interrupted");
      const journalDirectory = path.join(target.stateDir, "sync", "imports");
      const [journalName] = await readdir(journalDirectory);
      const journalPath = path.join(journalDirectory, journalName);
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { envelope: { ciphertext: string } };
      const ciphertext = Buffer.from(journal.envelope.ciphertext, "base64");
      ciphertext[0] ^= 1;
      journal.envelope.ciphertext = ciphertext.toString("base64");
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await rm(bundle);
      await expect(recoverPreparedEventImports(target)).rejects.toThrow("authentication failed");
      expect(await eventSyncStatus(target)).toMatchObject({ committedImports: 0, preparedImports: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tampering, immutable collisions, and secret memory fail before publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-denied-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "safe",
        value: "event",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);

      const envelope = JSON.parse(await readFile(bundle, "utf8")) as { ciphertext: string };
      envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
      const tampered = path.join(root, "tampered.bundle.json");
      await writeFile(tampered, `${JSON.stringify(envelope)}\n`);
      await expect(importEventBundle(target, tampered)).rejects.toThrow("authentication failed");

      const authenticEnvelope = JSON.parse(await readFile(bundle, "utf8")) as { nonce: string; authTag: string };
      const shortTag = {
        ...authenticEnvelope,
        authTag: Buffer.from(Buffer.from(authenticEnvelope.authTag, "base64").subarray(0, 8)).toString("base64"),
      };
      const shortTagBundle = path.join(root, "short-tag.bundle.json");
      await writeFile(shortTagBundle, `${JSON.stringify(shortTag)}\n`);
      await expect(importEventBundle(target, shortTagBundle)).rejects.toThrow("authentication tag must be exactly 16 bytes");

      const shortNonce = {
        ...authenticEnvelope,
        nonce: Buffer.from(Buffer.from(authenticEnvelope.nonce, "base64").subarray(0, 8)).toString("base64"),
      };
      const shortNonceBundle = path.join(root, "short-nonce.bundle.json");
      await writeFile(shortNonceBundle, `${JSON.stringify(shortNonce)}\n`);
      await expect(importEventBundle(target, shortNonceBundle)).rejects.toThrow("nonce must be exactly 12 bytes");

      const eventRoot = path.join(source.stateDir, "memory", "events");
      const [machine] = await readdir(eventRoot);
      const [eventName] = await readdir(path.join(eventRoot, machine));
      const collision = path.join(target.stateDir, "memory", "events", machine, eventName);
      await mkdir(path.dirname(collision), { recursive: true });
      await writeFile(collision, "{}\n");
      await expect(importEventBundle(target, bundle)).rejects.toThrow("immutable event collision");

      await mkdir(path.join(source.sessionsDir, ".hidden"), { recursive: true });
      await expect(exportEventBundle(source, path.join(root, "hidden.bundle.json"))).rejects.toThrow("hidden");

      const secretSource = await exchangeState(path.join(root, "secret-source"));
      await rememberMemory(secretSource, {
        scope: "project",
        subject: "Andromeda",
        predicate: "credential",
        value: "secret://AGENTS_SYNC_KEY",
        evidence,
        sensitivity: "secret",
      });
      await expect(exportEventBundle(secretSource, path.join(root, "secret.bundle.json"))).rejects.toThrow("local-only");

      const credentialUriSource = await exchangeState(path.join(root, "credential-uri"));
      await rememberMemory(credentialUriSource, {
        scope: "project",
        subject: "Andromeda",
        predicate: "credential-uri",
        value: "must-not-roam",
        evidence: { ...evidence, uri: "https://service:super-secret-password@example.invalid/evidence" },
      });
      await expect(
        exportEventBundle(credentialUriSource, path.join(root, "credential-uri.bundle.json")),
      ).rejects.toThrow("secret-like");

      const secretSession = await exchangeState(path.join(root, "secret-session"));
      await createSession(secretSession, {
        sessionId: "secret-session",
        provider: "codex",
        model: "gpt-5",
        mode: "task",
        workdir: "/workspace",
      });
      await withSessionWriteTransaction(secretSession, "secret-session", async (transaction) => {
        const turnId = await transaction.beginTurn();
        await transaction.appendMessage(turnId, {
          role: "user",
          content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        });
        await transaction.completeTurn(turnId);
      });
      await expect(exportEventBundle(secretSession, path.join(root, "secret-session.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const secretOrchestrator = await exchangeState(path.join(root, "secret-orchestrator"));
      await initializeOrchestratorState(secretOrchestrator, "secret-orchestrator", "codex", "gpt-5");
      await appendOrchestratorLedger(secretOrchestrator, "secret-orchestrator", {
        action: "probe",
        note: "postgres://service:correct-horse-battery-staple@database.internal/agents",
      });
      await expect(
        exportEventBundle(secretOrchestrator, path.join(root, "secret-orchestrator.bundle.json")),
      ).rejects.toThrow("secret-like");

      const alphabeticSecret = "dQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsD";
      const alphabeticMemory = await exchangeState(path.join(root, "alphabetic-memory"));
      await rememberMemory(alphabeticMemory, {
        scope: "project",
        subject: "Andromeda",
        predicate: "opaque-value",
        value: alphabeticSecret,
        evidence,
      });
      await expect(exportEventBundle(alphabeticMemory, path.join(root, "alphabetic-memory.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const alphabeticSession = await exchangeState(path.join(root, "alphabetic-session"));
      await createSession(alphabeticSession, {
        sessionId: "alphabetic-session",
        provider: "codex",
        model: "gpt-5",
        mode: "task",
        workdir: "/workspace",
      });
      await withSessionWriteTransaction(alphabeticSession, "alphabetic-session", async (transaction) => {
        const turnId = await transaction.beginTurn();
        await transaction.appendMessage(turnId, { role: "user", content: alphabeticSecret });
        await transaction.completeTurn(turnId);
      });
      await expect(exportEventBundle(alphabeticSession, path.join(root, "alphabetic-session.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const alphabeticOrchestrator = await exchangeState(path.join(root, "alphabetic-orchestrator"));
      await initializeOrchestratorState(alphabeticOrchestrator, "alphabetic-orchestrator", "codex", "gpt-5");
      await appendOrchestratorLedger(alphabeticOrchestrator, "alphabetic-orchestrator", {
        action: "probe",
        note: alphabeticSecret,
      });
      await expect(
        exportEventBundle(alphabeticOrchestrator, path.join(root, "alphabetic-orchestrator.bundle.json")),
      ).rejects.toThrow("secret-like");

      const structuralSecret = await exchangeState(path.join(root, "structural-secret"));
      await createSession(structuralSecret, {
        sessionId: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
        provider: "codex",
        model: "gpt-5",
        mode: "task",
        workdir: "/workspace",
      });
      await expect(exportEventBundle(structuralSecret, path.join(root, "structural-secret.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const sourceMetadataSecret = await exchangeState(path.join(root, "source-metadata-secret"));
      const manifestPath = path.join(sourceMetadataSecret.stateDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.machineId = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(
        exportEventBundle(sourceMetadataSecret, path.join(root, "source-metadata-secret.bundle.json")),
      ).rejects.toThrow("canonical non-secret identifier");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlinked canonical ancestors cannot redirect export reads or import writes", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-symlink-ancestor-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "symlink-boundary",
        value: "physical-only",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);

      const sourceMemory = path.join(source.stateDir, "memory");
      const movedSourceMemory = path.join(root, "source-memory-outside");
      await rename(sourceMemory, movedSourceMemory);
      await symlink(movedSourceMemory, sourceMemory, "dir");
      await expect(exportEventBundle(source, path.join(root, "redirected.bundle.json"))).rejects.toThrow("symbolic link");

      const target = await exchangeState(path.join(root, "target"));
      const targetMemory = path.join(target.stateDir, "memory");
      const movedTargetMemory = path.join(root, "target-memory-outside");
      await rename(targetMemory, movedTargetMemory);
      await symlink(movedTargetMemory, targetMemory, "dir");
      await expect(importEventBundle(target, bundle)).rejects.toThrow("symbolic link");
      expect((await readdir(path.join(movedTargetMemory, "events"), { recursive: true })).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlinked sync journal ancestors cannot redirect import metadata", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-journal-symlink-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "journal-boundary",
        value: "physical-only",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);

      const syncTarget = await exchangeState(path.join(root, "sync-target"));
      const syncDirectory = path.join(syncTarget.stateDir, "sync");
      const movedSyncDirectory = path.join(root, "sync-outside");
      await rename(syncDirectory, movedSyncDirectory);
      await symlink(movedSyncDirectory, syncDirectory, "dir");
      await expect(enableEventSync(syncTarget)).rejects.toThrow("symbolic link");
      await expect(importEventBundle(syncTarget, bundle)).rejects.toThrow("symbolic link");

      const importsTarget = await exchangeState(path.join(root, "imports-target"));
      const importsDirectory = path.join(importsTarget.stateDir, "sync", "imports");
      const movedImportsDirectory = path.join(root, "imports-outside");
      await rename(importsDirectory, movedImportsDirectory);
      await symlink(movedImportsDirectory, importsDirectory, "dir");
      await expect(importEventBundle(importsTarget, bundle)).rejects.toThrow("symbolic link");
      expect((await readdir(movedImportsDirectory)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
