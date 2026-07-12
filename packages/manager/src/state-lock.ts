import { randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

export interface LockStateRoot {
  stateDir: string;
}

export interface RenewableLockOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
  owner?: string;
}

export interface ActiveRenewableLock {
  readonly key: string;
  verify(): Promise<void>;
  release(): Promise<void>;
}

export type StateLockOptions = RenewableLockOptions;

interface LeaseRow {
  token: string;
  expiresAt: number;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const localTails = new Map<string, Promise<void>>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const result = Math.ceil(value ?? fallback);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
}

function requiredOwner(value: string): string {
  if (!value || value.includes("\0") || value.length > 512) throw new Error("renewable lock owner is invalid");
  return value;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export function renewableLockDatabasePath(state: LockStateRoot): string {
  return path.join(state.stateDir, "runtime", "locks", "leases.sqlite");
}

async function openLeaseDatabase(state: LockStateRoot, busyTimeoutMs: number): Promise<Database> {
  const databasePath = renewableLockDatabasePath(state);
  const directory = path.dirname(databasePath);
  await ensurePrivateDirectory(directory);
  try {
    const info = await lstat(databasePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`renewable lock database must be a regular file: ${databasePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const database = new Database(databasePath, { create: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS renewable_leases (
        key TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL,
        owner TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    if (process.platform !== "win32") await chmod(databasePath, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function ownershipLost(key: string): Error {
  return new Error(`canonical renewable lock ownership was lost: ${key}`);
}

function isBusy(error: unknown): boolean {
  return (error as { code?: string }).code === "SQLITE_BUSY" || String(error).includes("database is locked");
}

export async function acquireRenewableStateLock(
  state: LockStateRoot,
  key: string,
  options: RenewableLockOptions = {},
): Promise<ActiveRenewableLock> {
  if (!SAFE_KEY.test(key)) throw new Error(`invalid canonical renewable lock key: ${key}`);
  const leaseMs = duration(options.leaseMs, 30_000, "renewable lock lease");
  const heartbeatMs = duration(
    options.heartbeatMs,
    Math.min(5_000, Math.max(1, Math.floor(leaseMs / 3))),
    "renewable lock heartbeat",
  );
  const waitMs = duration(options.waitMs, 30_000, "renewable lock wait");
  if (heartbeatMs >= leaseMs) throw new Error("renewable lock heartbeat must be shorter than its lease");

  const owner = requiredOwner(options.owner ?? key);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  const database = await openLeaseDatabase(state, Math.min(waitMs, 1_000));
  const acquire = database.query(`
    INSERT INTO renewable_leases (
      key, token, owner, pid, process_started_at, acquired_at, expires_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(key) DO UPDATE SET
      token = excluded.token,
      owner = excluded.owner,
      pid = excluded.pid,
      process_started_at = excluded.process_started_at,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE renewable_leases.expires_at <= ?8
  `);

  while (Date.now() < deadline) {
    const now = Date.now();
    try {
      const result = acquire.run(
        key,
        token,
        owner,
        process.pid,
        PROCESS_STARTED_AT,
        new Date(now).toISOString(),
        now + leaseMs,
        now,
      );
      if (result.changes === 1) {
        let stopped = false;
        let lost: Error | null = null;
        const renew = database.query(`
          UPDATE renewable_leases
          SET expires_at = ?1
          WHERE key = ?2 AND token = ?3 AND expires_at > ?4
        `);
        const remove = database.query("DELETE FROM renewable_leases WHERE key = ?1 AND token = ?2");
        const read = database.query<LeaseRow, [string]>(
          "SELECT token, expires_at AS expiresAt FROM renewable_leases WHERE key = ?1",
        );

        const renewOrLose = (): void => {
          if (stopped) throw ownershipLost(key);
          if (lost) throw lost;
          const renewalTime = Date.now();
          try {
            if (renew.run(renewalTime + leaseMs, key, token, renewalTime).changes !== 1) {
              lost = ownershipLost(key);
              throw lost;
            }
          } catch (error) {
            lost = error instanceof Error ? error : new Error(String(error));
            throw lost;
          }
        };

        const timer = setInterval(() => {
          if (stopped || lost) return;
          try {
            renewOrLose();
          } catch {
            // The next explicit verification reports the stored failure.
          }
        }, heartbeatMs);
        timer.unref?.();

        return {
          key,
          verify: async () => {
            renewOrLose();
            const current = read.get(key);
            if (!current || current.token !== token || current.expiresAt <= Date.now()) {
              lost = ownershipLost(key);
              throw lost;
            }
          },
          release: async () => {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            try {
              // Token-qualified deletion is the ABA boundary: an expired owner can
              // never delete a lease installed by a later conditional UPSERT.
              remove.run(key, token);
            } finally {
              database.close();
            }
          },
        };
      }
    } catch (error) {
      if (!isBusy(error)) {
        database.close();
        throw error;
      }
    }
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }

  database.close();
  throw new Error(`timed out waiting for canonical renewable lock: ${key}`);
}

export async function withRenewableStateLock<T>(
  state: LockStateRoot,
  key: string,
  callback: (lock: ActiveRenewableLock) => Promise<T>,
  options: RenewableLockOptions = {},
): Promise<T> {
  const lock = await acquireRenewableStateLock(state, key, options);
  try {
    const result = await callback(lock);
    await lock.verify();
    return result;
  } finally {
    await lock.release();
  }
}

export async function withStateFileLock<T>(
  state: LockStateRoot,
  key: string,
  callback: () => Promise<T>,
  options: StateLockOptions = {},
): Promise<T> {
  if (!SAFE_KEY.test(key)) throw new Error(`invalid canonical state lock key: ${key}`);
  const localKey = path.join(path.resolve(state.stateDir), key);
  const previous = localTails.get(localKey) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => gate);
  localTails.set(localKey, tail);
  await previous;
  try {
    return await withRenewableStateLock(state, `state:${key}`, () => callback(), {
      ...options,
      owner: options.owner ?? `state:${key}`,
    });
  } finally {
    releaseLocal();
    if (localTails.get(localKey) === tail) localTails.delete(localKey);
  }
}
