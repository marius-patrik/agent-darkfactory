import { describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../src/state";
import { writeSecret } from "../src/secrets";
import { rebuildMemoryProjections, rememberMemory, supersedeMemory } from "../src/memory";
import {
  createSession,
  inspectSessionIntegrity,
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
        value: "0123456789abcdef0123456789abcdef01234567",
        evidence,
      });
      await supersedeMemory(source, original.id, {
        value: "89abcdef0123456789abcdef0123456789abcdef",
        evidence,
      });
      await rememberMemory(source, {
        scope: "project",
        subject: "task-board",
        predicate: "location",
        value: "canonical owner-facing board",
        evidence: { ...evidence, uri: "file:///C:/Users/patrik/marius-patrik/Andromeda/data/agent-os/context/TASK.md" },
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
      const exported = await exportEventBundle(source, path.join(root, "safe-identifiers.bundle.json"));
      expect(exported.entries).toBe(7);
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
