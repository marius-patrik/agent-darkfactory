import { describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState, type SharedState } from "../src/state";
import { writeSecret } from "../src/secrets";
import { rebuildMemoryProjections, rememberMemory, retractMemory, supersedeMemory } from "../src/memory";
import {
  createSession,
  inspectSessionIntegrity,
  sessionPaths,
  withSessionWriteLock,
  withSessionWriteTransaction,
} from "../../harness/session";
import { doctorState } from "../src/state-doctor";
import { appendOrchestratorLedger, initializeOrchestratorState } from "../src/orchestrator";
import {
  disableEventSync,
  enableEventSync,
  eventSyncStatus,
  exportEventBundle,
  importEventBundle,
  recoverPreparedEventImports,
} from "../src/event-sync";

const key = "7b".repeat(32);
const aadPrefix = "andromeda-agent-os-event-exchange-v1:";
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

async function appendAssistantMessage(state: SharedState, sessionId: string, content: string): Promise<void> {
  await createSession(state, {
    sessionId,
    provider: "codex",
    model: "gpt-5",
    mode: "task",
    workdir: "/workspace",
  });
  await withSessionWriteTransaction(state, sessionId, async (transaction) => {
    const turnId = await transaction.beginTurn();
    await transaction.appendMessage(turnId, {
      role: "assistant",
      content,
      metadata: { error: "synthetic fixture" },
    });
    await transaction.completeTurn(turnId);
  });
}

async function assistantMessageState(root: string, sessionId: string, content: string) {
  const state = await exchangeState(root);
  await appendAssistantMessage(state, sessionId, content);
  return state;
}

async function rewriteAuthenticatedBundlePath(
  sourcePath: string,
  targetPath: string,
  rewrite: (relativePath: string) => string,
): Promise<void> {
  const envelope = JSON.parse(await readFile(sourcePath, "utf8")) as {
    schemaVersion: 1;
    algorithm: "aes-256-gcm";
    payloadHash: string;
    nonce: string;
    authTag: string;
    ciphertext: string;
  };
  const secret = Buffer.from(key, "hex");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(`${aadPrefix}${envelope.payloadHash}`));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const payload = JSON.parse(plaintext) as { entries: Array<{ path: string }> };
  payload.entries[0].path = rewrite(payload.entries[0].path);
  const rewritten = JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(rewritten).digest("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(Buffer.from(`${aadPrefix}${payloadHash}`));
  const ciphertext = Buffer.concat([cipher.update(rewritten, "utf8"), cipher.final()]);
  await writeFile(targetPath, `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    payloadHash,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }, null, 2)}\n`);
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

  test("same-machine appends cannot cross the validation-publication lock boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-same-machine-race-"));
    try {
      const target = await exchangeState(path.join(root, "target"));
      const source = await exchangeState(path.join(root, "source"));
      const targetManifest = JSON.parse(await readFile(path.join(target.stateDir, "manifest.json"), "utf8")) as {
        machineId: string;
      };
      const sourceManifestPath = path.join(source.stateDir, "manifest.json");
      const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8")) as Record<string, unknown>;
      sourceManifest.machineId = targetManifest.machineId;
      await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "incoming-same-machine",
        value: "first",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);

      let appendSettled = false;
      let concurrentAppend: ReturnType<typeof rememberMemory> | undefined;
      const imported = await importEventBundle(target, bundle, {
        afterValidationBeforePublication: async () => {
          concurrentAppend = rememberMemory(target, {
            scope: "project",
            subject: "Andromeda",
            predicate: "local-same-machine",
            value: "second",
            evidence,
          });
          void concurrentAppend.finally(() => {
            appendSettled = true;
          });
          await Bun.sleep(75);
          expect(appendSettled).toBe(false);
        },
      });
      expect(imported.imported).toBe(1);
      await concurrentAppend;
      expect((await doctorState(target)).checks.find((check) => check.id === "memory_integrity")?.ok).toBe(true);
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
      const collisionEvent = JSON.parse(await readFile(path.join(eventRoot, machine, eventName), "utf8")) as Record<string, unknown>;
      collisionEvent.collision = true;
      await writeFile(collision, `${JSON.stringify(collisionEvent, null, 2)}\n`);
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

      const structuredScalarSource = await exchangeState(path.join(root, "structured-scalar"));
      await rememberMemory(structuredScalarSource, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: JSON.stringify({
          schemaVersion: 2,
          capsuleId: "20260713-041342-a6578aaf9ed84b448d7c41008e04a2e2",
          blocker: "DarkFactory CODEX_AUTH_JSON GitHub secret is expired and must be refreshed",
          repository: "marius-patrik/Andromeda",
          commit: "6175e4d0b5736d2ebbfc6f21a9d8111e1ba83525",
        }),
        evidence,
      });
      await expect(
        exportEventBundle(structuredScalarSource, path.join(root, "structured-scalar.bundle.json")),
      ).resolves.toMatchObject({ entries: 1 });

      const retractedStructuredScalar = await exchangeState(path.join(root, "retracted-structured-scalar"));
      const retractedRecord = await rememberMemory(retractedStructuredScalar, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: JSON.stringify({ capsuleId: "20260713-041342-a6578aaf9ed84b448d7c41008e04a2e2" }),
        evidence,
      });
      await retractMemory(retractedStructuredScalar, retractedRecord.id, evidence, "publication failed");
      await expect(
        exportEventBundle(retractedStructuredScalar, path.join(root, "retracted-structured-scalar.bundle.json")),
      ).resolves.toMatchObject({ entries: 2 });

      const structuredSecretSource = await exchangeState(path.join(root, "structured-secret"));
      await rememberMemory(structuredSecretSource, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: JSON.stringify({ apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }),
        evidence,
      });
      await expect(
        exportEventBundle(structuredSecretSource, path.join(root, "structured-secret.bundle.json")),
      ).rejects.toThrow("secret-like");

      const capsuleIdSecretSource = await exchangeState(path.join(root, "capsule-id-secret"));
      await rememberMemory(capsuleIdSecretSource, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: JSON.stringify({ capsuleId: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }),
        evidence,
      });
      await expect(
        exportEventBundle(capsuleIdSecretSource, path.join(root, "capsule-id-secret.bundle.json")),
      ).rejects.toThrow("secret-like");

      const duplicateStructuredSecret = await exchangeState(path.join(root, "duplicate-structured-secret"));
      await rememberMemory(duplicateStructuredSecret, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: '{"apiKey":"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789","apiKey":"redacted"}',
        evidence,
      });
      await expect(
        exportEventBundle(duplicateStructuredSecret, path.join(root, "duplicate-structured-secret.bundle.json")),
      ).rejects.toThrow("secret-like");

      const deeplyNestedSecret = await exchangeState(path.join(root, "deeply-nested-secret"));
      const nestedDepth = 5_000;
      const deeplyNestedValue = `${'{"child":'.repeat(nestedDepth)}{"apiKey":"redacted"}${"}".repeat(nestedDepth)}`;
      await rememberMemory(deeplyNestedSecret, {
        scope: "session",
        subject: "compaction",
        predicate: "current",
        value: deeplyNestedValue,
        evidence,
      });
      await expect(
        exportEventBundle(deeplyNestedSecret, path.join(root, "deeply-nested-secret.bundle.json")),
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

      const alphabeticSecret = ["dQwErTyUiOpA", "sDfGhJkLzXc", "VbNmQwErTyU", "iOpAsD"].join("");
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

      const slashSecret = await exchangeState(path.join(root, "slash-secret"));
      await rememberMemory(slashSecret, {
        scope: "project",
        subject: "Andromeda",
        predicate: "opaque-value",
        value: "aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evidence,
      });
      await expect(exportEventBundle(slashSecret, path.join(root, "slash-secret.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const unqualifiedLineageSecret = await exchangeState(path.join(root, "unqualified-lineage-secret"));
      await rememberMemory(unqualifiedLineageSecret, {
        scope: "project",
        subject: "Andromeda",
        predicate: "opaque-value",
        value: "(renamed from aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)",
        evidence,
      });
      await expect(
        exportEventBundle(unqualifiedLineageSecret, path.join(root, "unqualified-lineage-secret.bundle.json")),
      ).rejects.toThrow("secret-like");

      const urlPathSecret = await exchangeState(path.join(root, "url-path-secret"));
      await rememberMemory(urlPathSecret, {
        scope: "project",
        subject: "Andromeda",
        predicate: "opaque-value",
        value: "https://example.invalid/dQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsD",
        evidence,
      });
      await expect(exportEventBundle(urlPathSecret, path.join(root, "url-path-secret.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const splitUrlPathSecret = await exchangeState(path.join(root, "split-url-path-secret"));
      await rememberMemory(splitUrlPathSecret, {
        scope: "project",
        subject: "Andromeda",
        predicate: "opaque-value",
        value: "https://example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        evidence,
      });
      await expect(
        exportEventBundle(splitUrlPathSecret, path.join(root, "split-url-path-secret.bundle.json")),
      ).rejects.toThrow("secret-like");

      for (const [name, value] of [
        ["redis", "redis://cache.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"],
        ["custom", "custom+v1://service.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"],
        ["scheme-relative", "//example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"],
      ] as const) {
        const schemePathSecret = await exchangeState(path.join(root, `${name}-scheme-path-secret`));
        await rememberMemory(schemePathSecret, {
          scope: "project",
          subject: "Andromeda",
          predicate: "opaque-value",
          value,
          evidence,
        });
        await expect(
          exportEventBundle(schemePathSecret, path.join(root, `${name}-scheme-path-secret.bundle.json`)),
        ).rejects.toThrow("secret-like");
      }

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

  test("canonical repository paths and Git commits are not mistaken for secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-safe-identifiers-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "canonical-remote",
        value:
          "https://github.com/marius-patrik/Andromeda; released v0.2.0; dev=main",
        evidence,
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "previous-remote",
        value: "https://github.com/marius-patrik/andromeda-platform (renamed from marius-patrik/agents-manager-platform)",
        evidence,
      });
      const original = await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "release-commit",
        value: "0123456789abcdef0123456789abcdef01234567.",
        evidence,
      });
      await supersedeMemory(source, original.id, {
        value: "89abcdef0123456789abcdef0123456789abcdef.",
        evidence,
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "task-board",
        predicate: "location",
        value: "canonical owner-facing board",
        evidence: { ...evidence, uri: "file:///C:/Users/patrik/marius-patrik/Andromeda/data/andromeda/context/TASK.md" },
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "session",
        predicate: "identifier",
        value: "canonical machine 906f1326-7ced-41f3-97d5-69df9dd6ad2f",
        evidence,
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "repository",
        predicate: "canonical-slug",
        value: "marius.patrik/andromeda.platform-long-repository-name",
        evidence,
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "memory-event",
        predicate: "canonical-evidence-uri",
        value: "canonical long-slug evidence file",
        evidence: {
          ...evidence,
          uri: "file:///C:/Users/patrik/.agents/experience/active-memory-session-20260715.json",
        },
      });
      const exported = await exportEventBundle(source, path.join(root, "safe-identifiers.bundle.json"));
      expect(exported.entries).toBe(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ordinary absolute path segments in assistant events are admitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-ordinary-absolute-path-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "ordinary-absolute-path",
        "Read failed at /home/runner/work/Andromeda/packages/manager/src/event-sync.ts",
      );
      const exported = await exportEventBundle(source, path.join(root, "ordinary-absolute-path.bundle.json"));
      expect(exported.entries).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit provider tokens inside absolute paths remain denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-token-path-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "token-path",
        "Read failed at /var/cache/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/report.json",
      );
      await expect(exportEventBundle(source, path.join(root, "token-path.bundle.json"))).rejects.toThrow(
        "secret-like",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("opaque high-entropy absolute path segments remain denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-opaque-path-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "opaque-path",
        "Read failed at /var/cache/abcdefghijklmnopqrstuvwxyzabcdef/report.json",
      );
      await expect(exportEventBundle(source, path.join(root, "opaque-path.bundle.json"))).rejects.toThrow(
        "secret-like",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("UUID and hash segments inside absolute paths remain denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-identifier-path-"));
    try {
      const uuidSource = await assistantMessageState(
        path.join(root, "uuid-source"),
        "uuid-path",
        "Read failed at /var/cache/906f1326-7ced-41f3-97d5-69df9dd6ad2f/report.json",
      );
      await expect(exportEventBundle(uuidSource, path.join(root, "uuid-path.bundle.json"))).rejects.toThrow(
        "secret-like",
      );

      const hashSource = await assistantMessageState(
        path.join(root, "hash-source"),
        "hash-path",
        "Read failed at /var/cache/0123456789abcdef0123456789abcdef01234567/report.json",
      );
      await expect(exportEventBundle(hashSource, path.join(root, "hash-path.bundle.json"))).rejects.toThrow(
        "secret-like",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("minimum GitHub tokens after underscore path punctuation remain denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-underscore-token-path-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "underscore-token-path",
        "Read failed at /var/cache/_ghp_ABCDEFGHIJKLMNOPQRST/report.json",
      );
      await expect(
        exportEventBundle(source, path.join(root, "underscore-token-path.bundle.json")),
      ).rejects.toThrow("secret-like");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit token families honor punctuation boundaries without matching alphanumeric prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-explicit-token-boundaries-"));
    try {
      const syntheticAwsAccessKeyId = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
      const deniedMessages = [
        ["aws", `Read failed at /var/cache/_${syntheticAwsAccessKeyId}/report.json`],
        ["google", "Read failed at file:///var/cache/_AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcd/report.json"],
        ["jwt", "Read failed at /var/cache/_eyJabcdefgh.ijklmnop.qrstuvwx/report.json"],
        ["bearer", "Failure: _Bearer abcdefghijklmnop"],
        ["assignment", "Failure: _token=abcdefgh"],
      ] as const;
      for (const [name, message] of deniedMessages) {
        const source = await assistantMessageState(path.join(root, `${name}-source`), `${name}-boundary`, message);
        await expect(exportEventBundle(source, path.join(root, `${name}.bundle.json`))).rejects.toThrow(
          "secret-like",
        );
      }

      const embeddedSource = await assistantMessageState(
        path.join(root, "embedded-source"),
        "embedded-identifiers",
        "Identifiers notAKIAABCDEFGHIJKLMNOP and notghp_ABCDEFGHIJKLMNOPQRST are ordinary prose",
      );
      const exported = await exportEventBundle(embeddedSource, path.join(root, "embedded.bundle.json"));
      expect(exported.entries).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ordinary absolute paths after colon and bracket punctuation are admitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-punctuated-path-"));
    try {
      const colonSource = await assistantMessageState(
        path.join(root, "colon-source"),
        "colon-path",
        "Read failed:/home/runner/work/Andromeda/packages/manager/src/event-sync.ts",
      );
      const colonExport = await exportEventBundle(colonSource, path.join(root, "colon-path.bundle.json"));
      expect(colonExport.entries).toBeGreaterThan(0);

      const bracketSource = await assistantMessageState(
        path.join(root, "bracket-source"),
        "bracket-path",
        "Read failed [C:\\Users\\patrik\\marius-patrik\\Andromeda\\packages\\manager\\src\\event-sync.ts]",
      );
      const bracketExport = await exportEventBundle(bracketSource, path.join(root, "bracket-path.bundle.json"));
      expect(bracketExport.entries).toBeGreaterThan(0);

      const uncSource = await assistantMessageState(
        path.join(root, "unc-source"),
        "punctuated-unc-path",
        "Read failed:[\\\\server\\share\\Andromeda\\packages\\manager\\src\\event-sync.ts]",
      );
      const uncExport = await exportEventBundle(uncSource, path.join(root, "punctuated-unc-path.bundle.json"));
      expect(uncExport.entries).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounded absolute paths admit ordinary spaces and filesystem punctuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-spaced-paths-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const messages = [
        'Read failed at "C:\\Users\\Patrik Smith\\marius-patrik\\Andromeda\\packages\\manager\\src\\event-sync.ts"',
        "Read failed at '/home/Patrik Smith/Andromeda/packages/manager/src/event-sync.ts'",
        "Read failed at \\\\server\\share\\Andromeda-1\\packages\\manager\\src\\event-sync.ts",
        'Read failed at "/home/Patrik VeryLongSurname/Andromeda/packages/manager/src/event-sync.ts"',
        'Read failed at "C:\\Users\\Patrik VeryLongSurname\\Andromeda\\packages\\manager\\src\\event-sync.ts"',
        'Read failed at "C:\\Program Files\\Agent OS\\Event Sync Log.txt": access denied',
        'Read failed at "C:\\Program Files (x86)\\Agent OS\\Event Sync Log.txt"',
        "Read failed at (C:\\Program Files (x86)\\AgentOS\\Andromeda\\packages\\manager\\src\\event-sync.ts)",
        "Read failed at '/home/Agent OS/Event Sync Log.txt', retrying",
        "Read failed at '/opt/Agent Data/Event Sync Log.txt'",
        "Read failed at '/home/patrik smith/Mary Jane Watson/Event Sync Log.txt'",
        "Read failed at /safe/GraphQLHTTPAPI.ts",
        "Read failed at /safe/release20260715/report.txt",
        "Read failed at C:\\safe\\EventSyncV2Handler.ts",
        "Read failed at /safe/windows-2026-build/GraphQLHTTPAPI.ts",
        'Read failed at "/safe/Project release-20260715/report.txt"',
        "Read failed at file:///C:/Users/patrik/.agents/experience/active-memory-session-reorient-20260715.json",
        "Read failed at file:///C:/Users/patrik/.agents/memory/snapshots/compaction/20260715-102030-0123456789abcdef0123456789abcdef.json",
        "Read failed at file:///C:/Users/patrik/.agents/memory/snapshots/compaction/20260715-102030-0123456789abcdef0123456789abcdef-rollback.json",
        'Compared "C:\\Users\\Patrik Smith\\Andromeda\\src\\file.ts" and "/home/Patrik Smith/Andromeda/src/file.ts"',
      ] as const;
      for (const [index, message] of messages.entries()) {
        const sessionId = `spaced-path-${index}`;
        const bundle = path.join(root, `${sessionId}.bundle.json`);
        await appendAssistantMessage(source, sessionId, message);
        try {
          const exported = await exportEventBundle(source, bundle);
          expect(exported.entries).toBeGreaterThan(0);
        } finally {
          await rm(sessionPaths(source, sessionId).dir, { recursive: true, force: true });
          await rm(bundle, { force: true });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonical DarkFactory worker control paths are admitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-darkfactory-control-paths-"));
    try {
      const messages = [
        "Write a concise final summary to .darkfactory/df-worker-summary.md before finishing.",
        "Read .darkfactory\\df-task-brief.md and update .darkfactory\\df-worker-summary.md.",
      ] as const;
      for (const [index, message] of messages.entries()) {
        const source = await assistantMessageState(path.join(root, `source-${index}`), `df-control-${index}`, message);
        const exported = await exportEventBundle(source, path.join(root, `df-control-${index}.bundle.json`));
        expect(exported.entries).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonical public workflow shorthands are admitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-public-workflow-shorthands-"));
    try {
      const messages = [
        "Worker policy forbids review/admin/bypass/force-push/deletion across the protected lane.",
        "Never permit review/admin/bypass/force-push/deletion.",
        "Use CLI/state/secrets/source-install for the managed boundary.",
        "Expose install/enable/disable/status/repair commands.",
      ] as const;
      for (const [index, message] of messages.entries()) {
        const source = await assistantMessageState(path.join(root, `source-${index}`), `policy-${index}`, message);
        const exported = await exportEventBundle(source, path.join(root, `policy-${index}.bundle.json`));
        expect(exported.entries).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounded absolute paths preserve secret-like suffixes and ambiguous spans", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-bounded-path-denials-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const opaqueSuffix = ["dQwErTyUiOpA", "sDfGhJkLzXc", "VbNmQwErTyU", "iOpAsD"].join("");
      const githubToken = ["gh", "p_", "ABCDEFGHIJKLMNOPQRST"].join("");
      const deniedMessages = [
        "Read failed at C:\\Users\\Patrik Smith\\marius-patrik\\Andromeda\\packages\\manager\\src\\event-sync.ts",
        "Read failed at /home/Patrik Smith/Andromeda/packages/manager/src/event-sync.ts",
        "Read failed at C:\\Users\\Patrik Smith\\cache\\abcdefghijklmnopqrstuvwxyzabcdef\\report.json",
        `Read failed at C:\\Users\\Patrik Smith\\_${githubToken}\\report.json`,
        `Read failed at C:\\Users\\Patrik Smith\\Andromeda\\event-sync.ts ${opaqueSuffix}`,
        "Read failed at C:\\Users\\Patrik Smith\\Andromeda\\event-sync.ts dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        "Read failed at /home/Patrik Smith/Andromeda/event-sync.ts then dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        'Read failed at "/home/Agent OS/event-sync.ts then dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"',
        'Read failed at "/safe/src dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"',
        "Read failed at file:///var/cache/abcdefghijklmnopqrstuvwxyzabcdef/report.json",
        'Read failed at "/safe/src abcdefghijklmnop/qrstuvwxyzabcdef/ghijklmnopqrstuv"',
        "Read failed at file:///safe/abcdefghijklmnop/qrstuvwxyzabcdef/ghijklmnopqrstuv",
        'Read failed at "/safe/src/dQwErTyUiOpAsDfG/x/hJkLzXcVbNmQwErT/y/0123456789"',
        'Read failed at "/safe/Ab3dEf5h_Ij7lMn9p/report.json"',
        'Read failed at "/safe/Ab3dEf5h+Ij7lMn9p/report.json"',
        'Read failed at "/safe/Ab3dEf5h.Ij7lMn9p/report.json"',
        'Read failed at "/safe/Ab3d-Ef5h-Ij7l-Mn9p/report.json"',
        'Read failed at "/safe/gh7k2m9q-pr8vz4nx-w6ty3abc.json"',
        'Read failed at "/safe/ghijkl-memory-session-20260715.json"',
        'Read failed at "/safe/active-memory-session-20260715.json/report.txt"',
        'Read failed at "/safe/20260715-102030-0123456789abcdef0123456789abcdef.json"',
        'Read failed at "/safe/20260715-102030-0123456789abcdef0123456789abcdef-rollback.json"',
        "Read failed at file:///C:/Users/patrik/.agents/memory/snapshots/compaction/20260715-102030-0123456789abcdef0123456789abcdef-rollback-extra.json",
        "Read failed at /safe/src dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        "Read failed at C:\\safe\\src dQwErTyUiOpAsDfG\\hJkLzXcVbNmQwErT\\0123456789",
        "Read failed at /safe/src cache/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        "Read failed at /safe/src AbcDef12345/GhiJkl67890/MnoPqr24680",
        "Read failed at C:\\safe\\src AbcDef12345\\GhiJkl67890\\MnoPqr24680",
        "Read failed at /home/Patrik Smith/Andromeda/runner //example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
        'Read failed at "/safe/src:https://example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"',
        'Read failed at "/safe/src:custom+v1://example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"',
        'Read failed at "C:\\Users\\Patrik Smith\\Andromeda\\runner then https://example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789"',
        "Read failed at C:\\Users\\Patrik Smith\\Andromeda\\event-sync.ts token=abcdefgh",
        'Read failed at "C:\\Users\\Patrik Smith\\Andromeda\\packages\\manager\\src\\event-sync.ts',
        "Read failed at C:\\Users\\Patrik Smith\\Andromeda\\event-sync.ts then https://example.invalid/dQwErTyUiOpAsDfG/hJkLzXcVbNmQwErT/0123456789",
      ] as const;
      for (const [index, message] of deniedMessages.entries()) {
        const sessionId = `bounded-denial-${index}`;
        const bundle = path.join(root, `${sessionId}.bundle.json`);
        await appendAssistantMessage(source, sessionId, message);
        try {
          await expect(exportEventBundle(source, bundle)).rejects.toThrow("secret-like");
        } finally {
          await rm(sessionPaths(source, sessionId).dir, { recursive: true, force: true });
          await rm(bundle, { force: true });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("DarkFactory worker control-path admission remains exact and segment-bounded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-darkfactory-control-denials-"));
    try {
      const opaqueSuffix = ["dQwErTyUiOpA", "sDfGhJkLzXc", "VbNmQwErTyU", "iOpAsD"].join("");
      const messages = [
        `Read failed at .darkfactory/df-worker-summary.md/${opaqueSuffix}`,
        `Read failed at .darkfactory/${opaqueSuffix}.md`,
        `Read failed at prefix.darkfactory/df-worker-summary.md/${opaqueSuffix}`,
        `Read failed at prefix-.darkfactory/df-worker-summary.md/${opaqueSuffix}`,
        `Read failed at .darkfactory/df-worker-summary.md.${opaqueSuffix}`,
      ] as const;
      for (const [index, message] of messages.entries()) {
        const source = await assistantMessageState(path.join(root, `source-${index}`), `df-denial-${index}`, message);
        await expect(exportEventBundle(source, path.join(root, `df-denial-${index}.bundle.json`))).rejects.toThrow(
          "secret-like",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("public workflow shorthand admission remains exact and token-bounded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-public-workflow-denials-"));
    try {
      const opaqueSuffix = ["dQwErTyUiOpA", "sDfGhJkLzXc", "VbNmQwErTyU", "iOpAsD"].join("");
      const messages = [
        `${opaqueSuffix}/review/admin/bypass/force-push/deletion`,
        `review/admin/bypass/force-push/deletion/${opaqueSuffix}`,
        `review/admin/bypass/force-push/deletions/${opaqueSuffix}`,
        `review/admin/bypass/force-push/deletion.${opaqueSuffix}`,
        `${opaqueSuffix}/CLI/state/secrets/source-install`,
        `CLI/state/secrets/source-install/${opaqueSuffix}`,
        `CLI/state/secrets/source-installs/${opaqueSuffix}`,
        `CLI/state/secrets/source-install.${opaqueSuffix}`,
        `${opaqueSuffix}/install/enable/disable/status/repair`,
        `install/enable/disable/status/repair/${opaqueSuffix}`,
        `install/enable/disable/status/repairs/${opaqueSuffix}`,
        `install/enable/disable/status/repair.${opaqueSuffix}`,
      ] as const;
      for (const [index, message] of messages.entries()) {
        const source = await assistantMessageState(path.join(root, `source-${index}`), `policy-denial-${index}`, message);
        await expect(exportEventBundle(source, path.join(root, `policy-denial-${index}.bundle.json`))).rejects.toThrow(
          "secret-like",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unmatched path delimiters are scanned in bounded time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-unmatched-path-delimiters-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "unmatched-path-delimiters",
        "[/a".repeat(16_000),
      );
      const startedAt = performance.now();
      const exported = await exportEventBundle(source, path.join(root, "unmatched-path-delimiters.bundle.json"));
      expect(exported.entries).toBeGreaterThan(0);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ordinary native Windows path segments in assistant events are admitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-windows-path-"));
    try {
      const source = await assistantMessageState(
        path.join(root, "source"),
        "windows-path",
        "Read failed at C:\\Users\\patrik\\marius-patrik\\Andromeda\\packages\\manager\\src\\event-sync.ts",
      );
      const exported = await exportEventBundle(source, path.join(root, "windows-path.bundle.json"));
      expect(exported.entries).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("opaque native Windows and UNC path segments remain denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-windows-opaque-path-"));
    try {
      const windowsSource = await assistantMessageState(
        path.join(root, "windows-source"),
        "windows-opaque-path",
        "Read failed at C:\\Users\\patrik\\cache\\abcdefghijklmnopqrstuvwxyzabcdef\\report.json",
      );
      await expect(
        exportEventBundle(windowsSource, path.join(root, "windows-opaque-path.bundle.json")),
      ).rejects.toThrow("secret-like");

      const uncSource = await assistantMessageState(
        path.join(root, "unc-source"),
        "unc-opaque-path",
        "Read failed at \\\\server\\share\\cache\\abcdefghijklmnopqrstuvwxyzabcdef\\report.json",
      );
      await expect(exportEventBundle(uncSource, path.join(root, "unc-opaque-path.bundle.json"))).rejects.toThrow(
        "secret-like",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("authenticated entries are bound to machine, sequence, and event id paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-path-identity-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "path-identity",
        value: "bound",
        evidence,
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);
      const mismatches: Array<[string, (relativePath: string) => string]> = [
        ["machine", (relativePath) => relativePath.replace(/memory\/events\/[^/]+\//, "memory/events/11111111-1111-4111-8111-111111111111/")],
        ["sequence", (relativePath) => relativePath.replace(/\/0000000000000001-/, "/0000000000000002-")],
        ["event-id", (relativePath) => relativePath.replace(/-[A-Za-z0-9_-]+\.json$/, "-deadbeefdeadbeefdeadbeefdeadbeef.json")],
      ];
      for (const [name, rewrite] of mismatches) {
        const malformed = path.join(root, `${name}.bundle.json`);
        await rewriteAuthenticatedBundlePath(bundle, malformed, rewrite);
        await expect(importEventBundle(target, malformed)).rejects.toThrow("path identity mismatch");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("local-only secret history does not block importing safe roaming events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-local-secret-import-"));
    try {
      const source = await exchangeState(path.join(root, "source"));
      const target = await exchangeState(path.join(root, "target"));
      await rememberMemory(source, {
        scope: "project",
        subject: "Andromeda",
        predicate: "safe-roaming",
        value: "allowed",
        evidence,
      });
      await rememberMemory(target, {
        scope: "project",
        subject: "Andromeda",
        predicate: "local-credential",
        value: "secret://LOCAL_ONLY",
        evidence,
        sensitivity: "secret",
      });
      const bundle = path.join(root, "events.bundle.json");
      await exportEventBundle(source, bundle);
      const imported = await importEventBundle(target, bundle);
      expect(imported.imported).toBe(1);
      expect((await doctorState(target)).checks.find((check) => check.id === "memory_integrity")?.ok).toBe(true);
      await expect(exportEventBundle(target, path.join(root, "must-not-roam.bundle.json"))).rejects.toThrow("local-only");
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
