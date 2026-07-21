import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState } from "../src/state";
import {
  acquireRenewableStateLock,
  renewableLockDatabasePath,
  withStateFileLock,
} from "../src/state-lock";

const MARKER_TIMEOUT_MS = 30_000;
const RENEWAL_TIMEOUT_MS = 45_000;
const SINGLE_WORKER_EXIT_TIMEOUT_MS = 15_000;
const ALL_WORKER_EXIT_TIMEOUT_MS = 30_000;
const TRANSIENT_WINDOWS_CLEANUP_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const PRODUCTION_LOCK_OPTIONS = Object.freeze({
  leaseMs: 30_000,
  heartbeatMs: 5_000,
  waitMs: 30_000,
});
const HEARTBEAT_PROOF_OPTIONS = Object.freeze({
  leaseMs: 60_000,
  heartbeatMs: 5_000,
  waitMs: 30_000,
});

type RenewableLock = Awaited<ReturnType<typeof acquireRenewableStateLock>>;
type StateRoot = ReturnType<typeof sharedState>;

interface LeaseRow {
  token: string;
  owner: string;
  expiresAt: number;
}

interface Marker {
  file: string;
  label: string;
}

interface OwnedSubprocess {
  child: {
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    kill(): void;
  };
  stderr: Promise<string>;
}

interface SubprocessResult {
  code: number;
  stderr: string;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function spawnOwned(command: string[]): OwnedSubprocess {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  return { child, stderr: new Response(child.stderr).text() };
}

async function waitForMarkers(markers: readonly Marker[], timeoutMs = MARKER_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pending = [...markers];
  while (Date.now() < deadline) {
    const observed = await Promise.all(
      pending.map(async (marker) => ({ marker, exists: await Bun.file(marker.file).exists() })),
    );
    pending = observed.filter((entry) => !entry.exists).map((entry) => entry.marker);
    if (pending.length === 0) return;
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`timed out waiting for test subprocess markers: ${pending.map(({ label }) => label).join(", ")}`);
}

async function settleOwnedSubprocesses(
  owned: readonly OwnedSubprocess[],
  timeoutMs: number,
  label: string,
  terminateNow = false,
): Promise<SubprocessResult[]> {
  const deadline = Date.now() + timeoutMs;
  if (terminateNow) {
    for (const { child } of owned) {
      if (child.exitCode === null) child.kill();
    }
  }

  while (owned.some(({ child }) => child.exitCode === null) && Date.now() < deadline) {
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }

  let deadlineExceeded = owned.some(({ child }) => child.exitCode === null);
  if (deadlineExceeded) {
    for (const { child } of owned) {
      if (child.exitCode === null) child.kill();
    }
  }

  const results = await Promise.all(
    owned.map(async ({ child, stderr }) => ({ code: await child.exited, stderr: await stderr })),
  );
  deadlineExceeded ||= Date.now() > deadline;
  if (deadlineExceeded) throw new Error(`timed out settling test subprocesses: ${label}`);
  return results;
}

function isSqliteBusy(error: unknown): boolean {
  return (error as { code?: string }).code === "SQLITE_BUSY" || String(error).includes("database is locked");
}

function readLeaseRow(state: StateRoot, key: string): LeaseRow | null {
  const database = new Database(renewableLockDatabasePath(state), { readonly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    return database
      .query<LeaseRow, [string]>(
        "SELECT token, owner, expires_at AS expiresAt FROM renewable_leases WHERE key = ?1",
      )
      .get(key);
  } finally {
    database.close();
  }
}

function requireLeaseRow(row: LeaseRow | null, label: string): LeaseRow {
  if (!row) throw new Error(`expected authoritative lease row: ${label}`);
  return row;
}

function setAuthoritativeExpiry(state: StateRoot, key: string, expiresAt: number): void {
  const database = new Database(renewableLockDatabasePath(state));
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    const result = database
      .query("UPDATE renewable_leases SET expires_at = ?1 WHERE key = ?2")
      .run(expiresAt, key);
    if (result.changes !== 1) throw new Error(`expected one authoritative lease row: ${key}`);
  } finally {
    database.close();
  }
}

async function waitForAuthoritativeRenewal(
  state: StateRoot,
  key: string,
  initialExpiresAt: number,
): Promise<LeaseRow> {
  const deadline = Date.now() + RENEWAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const row = readLeaseRow(state, key);
      if (row && row.expiresAt > initialExpiresAt) return row;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new Error("timed out waiting for authoritative heartbeat renewal");
}

async function removeTestRoot(root: string): Promise<void> {
  if (process.platform !== "win32") {
    await rm(root, { recursive: true, force: true });
    return;
  }

  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_WINDOWS_CLEANUP_ERRORS.has(code) || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

describe("canonical mutable-state locks", () => {
  test(
    "transient database contention delays verification without forfeiting ownership",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-busy-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        let lock: RenewableLock | null = await acquireRenewableStateLock(
          state,
          "race:busy",
          PRODUCTION_LOCK_OPTIONS,
        );
        let blocker: OwnedSubprocess | null = null;
        try {
          const initial = requireLeaseRow(readLeaseRow(state, "race:busy"), "busy-owner");
          const ready = path.join(root, "blocker-ready");
          const release = path.join(root, "blocker-release");
          const code = `
            import { Database } from "bun:sqlite";
            const database = new Database(process.argv[1]);
            database.exec("BEGIN EXCLUSIVE");
            await Bun.write(process.argv[2], "ready\\n");
            while (!(await Bun.file(process.argv[3]).exists())) await Bun.sleep(10);
            database.exec("COMMIT");
            database.close();
          `;
          blocker = spawnOwned([process.execPath, "-e", code, renewableLockDatabasePath(state), ready, release]);

          await waitForMarkers([{ file: ready, label: "blocker-ready" }]);
          const verification = lock.verify();
          await Bun.write(release, "release\n");
          await verification;
          const [result] = await settleOwnedSubprocesses(
            [blocker],
            SINGLE_WORKER_EXIT_TIMEOUT_MS,
            "busy-blocker-exit",
          );
          expect(result).toEqual({ code: 0, stderr: "" });

          const renewed = requireLeaseRow(readLeaseRow(state, "race:busy"), "busy-renewed-owner");
          expect({ token: renewed.token, owner: renewed.owner }).toEqual({
            token: initial.token,
            owner: initial.owner,
          });
          expect(renewed.expiresAt).toBeGreaterThan(initial.expiresAt);

          await lock.release();
          lock = null;
          expect(readLeaseRow(state, "race:busy")).toBeNull();
        } finally {
          try {
            if (blocker) {
              await settleOwnedSubprocesses(
                [blocker],
                SINGLE_WORKER_EXIT_TIMEOUT_MS,
                "busy-blocker-exit",
                true,
              );
            }
          } finally {
            if (lock) await lock.release();
          }
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    120_000,
  );

  test(
    "database contention cannot revive a lease after its confirmed expiry",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-busy-expiry-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        let stale: RenewableLock | null = await acquireRenewableStateLock(
          state,
          "race:busy-expiry",
          PRODUCTION_LOCK_OPTIONS,
        );
        let successor: RenewableLock | null = null;
        let blocker: OwnedSubprocess | null = null;
        try {
          const staleRow = requireLeaseRow(readLeaseRow(state, "race:busy-expiry"), "busy-expiry-owner");
          const ready = path.join(root, "expiry-blocker-ready");
          const release = path.join(root, "expiry-blocker-release");
          const code = `
            import { Database } from "bun:sqlite";
            const database = new Database(process.argv[1]);
            database.exec("BEGIN EXCLUSIVE");
            database.query("UPDATE renewable_leases SET expires_at = 0 WHERE key = ?1").run(process.argv[4]);
            await Bun.write(process.argv[2], "ready\\n");
            while (!(await Bun.file(process.argv[3]).exists())) await Bun.sleep(10);
            database.exec("COMMIT");
            database.close();
          `;
          blocker = spawnOwned([
            process.execPath,
            "-e",
            code,
            renewableLockDatabasePath(state),
            ready,
            release,
            "race:busy-expiry",
          ]);

          await waitForMarkers([{ file: ready, label: "expiry-blocker-ready" }]);
          // Attach the rejection observer before releasing the database
          // blocker. On slow Windows runners the verification can reject
          // during the asynchronous marker write below; observing it only
          // afterwards lets Bun classify the correct fail-closed result as an
          // unhandled rejection.
          const verification = expect(stale.verify()).rejects.toThrow(
            "canonical renewable lock ownership was lost: race:busy-expiry",
          );
          await Bun.write(release, "release\n");
          await verification;
          const [result] = await settleOwnedSubprocesses(
            [blocker],
            SINGLE_WORKER_EXIT_TIMEOUT_MS,
            "expiry-blocker-exit",
          );
          expect(result).toEqual({ code: 0, stderr: "" });

          const expired = requireLeaseRow(readLeaseRow(state, "race:busy-expiry"), "confirmed-expired-owner");
          expect(expired).toEqual({ ...staleRow, expiresAt: 0 });

          successor = await acquireRenewableStateLock(state, "race:busy-expiry", {
            ...PRODUCTION_LOCK_OPTIONS,
            owner: "successor",
          });
          const successorRow = requireLeaseRow(
            readLeaseRow(state, "race:busy-expiry"),
            "busy-expiry-successor",
          );
          expect(successorRow.token).not.toBe(staleRow.token);
          expect(successorRow.owner).toBe("successor");

          await stale.release();
          stale = null;
          const afterStaleRelease = requireLeaseRow(
            readLeaseRow(state, "race:busy-expiry"),
            "busy-expiry-successor-after-stale-release",
          );
          expect({ token: afterStaleRelease.token, owner: afterStaleRelease.owner }).toEqual({
            token: successorRow.token,
            owner: successorRow.owner,
          });
          await successor.verify();
          await successor.release();
          successor = null;
          expect(readLeaseRow(state, "race:busy-expiry")).toBeNull();
        } finally {
          try {
            if (blocker) {
              await settleOwnedSubprocesses(
                [blocker],
                SINGLE_WORKER_EXIT_TIMEOUT_MS,
                "expiry-blocker-exit",
                true,
              );
            }
          } finally {
            try {
              if (successor) await successor.release();
            } finally {
              if (stale) await stale.release();
            }
          }
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    150_000,
  );

  test(
    "success: authoritative heartbeat renewal preserves ordered owner-to-successor handoff",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-heartbeat-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        const order: string[] = [];
        const firstEntered = gate();
        const releaseFirst = gate();
        const allowSecondAttempt = gate();
        const secondStarted = gate();
        let secondEntered = false;

        const first = withStateFileLock(
          state,
          "probe",
          async () => {
            order.push("first:entered");
            firstEntered.open();
            await releaseFirst.promise;
            order.push("first:leaving");
          },
          HEARTBEAT_PROOF_OPTIONS,
        );
        let firstFailed = false;
        let firstFailure: unknown;
        void first.catch((error) => {
          firstFailed = true;
          firstFailure = error;
          firstEntered.open();
        });
        let second: Promise<void> | null = null;
        try {
          await firstEntered.promise;
          if (firstFailed) throw firstFailure;
          const initial = requireLeaseRow(readLeaseRow(state, "state:probe"), "heartbeat-first-owner");
          const renewed = await waitForAuthoritativeRenewal(state, "state:probe", initial.expiresAt);
          expect({ token: renewed.token, owner: renewed.owner }).toEqual({
            token: initial.token,
            owner: initial.owner,
          });

          second = (async () => {
            await allowSecondAttempt.promise;
            const operation = withStateFileLock(
              state,
              "probe",
              async () => {
                secondEntered = true;
                order.push("second:entered");
              },
              HEARTBEAT_PROOF_OPTIONS,
            );
            secondStarted.open();
            await operation;
          })();
          allowSecondAttempt.open();
          await secondStarted.promise;

          const beforeHandoff = requireLeaseRow(
            readLeaseRow(state, "state:probe"),
            "heartbeat-owner-before-handoff",
          );
          expect({ token: beforeHandoff.token, owner: beforeHandoff.owner }).toEqual({
            token: renewed.token,
            owner: renewed.owner,
          });
          expect(secondEntered).toBe(false);

          releaseFirst.open();
          await Promise.all([first, second]);
          expect(order).toEqual(["first:entered", "first:leaving", "second:entered"]);
          expect(readLeaseRow(state, "state:probe")).toBeNull();
        } finally {
          allowSecondAttempt.open();
          releaseFirst.open();
          await Promise.allSettled(second ? [first, second] : [first]);
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    120_000,
  );

  test(
    "edge: an authoritatively expired subprocess cannot delete its token-distinct successor during stale release",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-aba-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        const ready = path.join(root, "owner-ready");
        const continuation = path.join(root, "owner-continue");
        const outcome = path.join(root, "owner-outcome");
        const stateModule = new URL("../src/state.ts", import.meta.url).href;
        const lockModule = new URL("../src/state-lock.ts", import.meta.url).href;
        const code = `
          import { sharedState } from ${JSON.stringify(stateModule)};
          import { acquireRenewableStateLock } from ${JSON.stringify(lockModule)};
          const state = sharedState(process.argv[1]);
          const lock = await acquireRenewableStateLock(state, "race:aba", {
            leaseMs: 30_000,
            heartbeatMs: 5_000,
            waitMs: 30_000,
            owner: "paused-owner",
          });
          await Bun.write(process.argv[2], "ready\\n");
          while (!(await Bun.file(process.argv[3]).exists())) await Bun.sleep(10);
          let result = "unexpectedly-verified";
          try {
            await lock.verify();
          } catch (error) {
            result = error instanceof Error && error.message.includes("ownership was lost")
              ? "ownership was lost"
              : "unexpected verification error";
          }
          await lock.release();
          await Bun.write(process.argv[4], result + "\\n");
        `;
        const worker = spawnOwned([process.execPath, "-e", code, root, ready, continuation, outcome]);
        let successor: RenewableLock | null = null;
        try {
          await waitForMarkers([{ file: ready, label: "owner-ready" }]);
          const staleRow = requireLeaseRow(readLeaseRow(state, "race:aba"), "aba-stale-owner");
          setAuthoritativeExpiry(state, "race:aba", 0);

          successor = await acquireRenewableStateLock(state, "race:aba", {
            ...PRODUCTION_LOCK_OPTIONS,
            owner: "successor",
          });
          const successorRow = requireLeaseRow(readLeaseRow(state, "race:aba"), "aba-successor");
          expect(successorRow.token).not.toBe(staleRow.token);
          expect(successorRow.owner).toBe("successor");

          await Bun.write(continuation, "continue\n");
          const [result] = await settleOwnedSubprocesses(
            [worker],
            SINGLE_WORKER_EXIT_TIMEOUT_MS,
            "aba-owner-exit",
          );
          expect(result).toEqual({ code: 0, stderr: "" });
          expect((await readFile(outcome, "utf8")).trim()).toBe("ownership was lost");

          const afterStaleRelease = requireLeaseRow(
            readLeaseRow(state, "race:aba"),
            "aba-successor-after-stale-release",
          );
          expect({ token: afterStaleRelease.token, owner: afterStaleRelease.owner }).toEqual({
            token: successorRow.token,
            owner: successorRow.owner,
          });
          await successor.verify();
          await successor.release();
          successor = null;
          expect(readLeaseRow(state, "race:aba")).toBeNull();
        } finally {
          try {
            await Bun.write(continuation, "continue\n");
          } finally {
            try {
              await settleOwnedSubprocesses(
                [worker],
                SINGLE_WORKER_EXIT_TIMEOUT_MS,
                "aba-owner-exit",
                true,
              );
            } finally {
              if (successor) await successor.release();
            }
          }
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    90_000,
  );

  test(
    "denied: an expired owner cannot renew itself or remove a live successor",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-expired-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        let stale: RenewableLock | null = await acquireRenewableStateLock(state, "race:expired", {
          ...PRODUCTION_LOCK_OPTIONS,
          owner: "expired-owner",
        });
        let replacement: RenewableLock | null = null;
        let third: RenewableLock | null = null;
        try {
          const staleRow = requireLeaseRow(readLeaseRow(state, "race:expired"), "expired-owner");
          setAuthoritativeExpiry(state, "race:expired", 0);
          await expect(stale.verify()).rejects.toThrow(
            "canonical renewable lock ownership was lost: race:expired",
          );

          replacement = await acquireRenewableStateLock(state, "race:expired", {
            ...PRODUCTION_LOCK_OPTIONS,
            owner: "replacement-owner",
          });
          const replacementRow = requireLeaseRow(
            readLeaseRow(state, "race:expired"),
            "replacement-owner",
          );
          expect(replacementRow.token).not.toBe(staleRow.token);
          expect(replacementRow.owner).toBe("replacement-owner");

          await stale.release();
          stale = null;
          const afterStaleRelease = requireLeaseRow(
            readLeaseRow(state, "race:expired"),
            "replacement-after-stale-release",
          );
          expect({ token: afterStaleRelease.token, owner: afterStaleRelease.owner }).toEqual({
            token: replacementRow.token,
            owner: replacementRow.owner,
          });

          let deniedError: unknown;
          try {
            third = await acquireRenewableStateLock(state, "race:expired", {
              ...PRODUCTION_LOCK_OPTIONS,
              owner: "denied-third-owner",
            });
          } catch (error) {
            deniedError = error;
          }
          if (third) {
            await third.release();
            third = null;
            throw new Error("denied third owner unexpectedly acquired canonical renewable lock");
          }
          expect(deniedError).toBeInstanceOf(Error);
          expect((deniedError as Error).message).toBe(
            "timed out waiting for canonical renewable lock: race:expired",
          );
          const afterDenial = requireLeaseRow(
            readLeaseRow(state, "race:expired"),
            "replacement-after-denied-owner",
          );
          expect({ token: afterDenial.token, owner: afterDenial.owner }).toEqual({
            token: replacementRow.token,
            owner: replacementRow.owner,
          });

          await replacement.release();
          replacement = null;
          expect(readLeaseRow(state, "race:expired")).toBeNull();
        } finally {
          try {
            const cleanupThird = third as RenewableLock | null;
            if (cleanupThird) await cleanupThird.release();
          } finally {
            try {
              if (replacement) await replacement.release();
            } finally {
              if (stale) await stale.release();
            }
          }
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    120_000,
  );

  test(
    "independent processes cannot lose read-modify-write updates",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-processes-"));
      try {
        const state = sharedState(root);
        await ensureSharedState(state);
        const counter = path.join(state.stateDir, "counter.txt");
        const start = path.join(root, "workers-start");
        await Bun.write(counter, "0\n");
        const stateModule = new URL("../src/state.ts", import.meta.url).href;
        const lockModule = new URL("../src/state-lock.ts", import.meta.url).href;
        const code = `
          import { sharedState } from ${JSON.stringify(stateModule)};
          import { withStateFileLock } from ${JSON.stringify(lockModule)};
          const root = process.argv[1];
          const counter = process.argv[2];
          const ready = process.argv[3];
          const start = process.argv[4];
          const complete = process.argv[5];
          await Bun.write(ready, "ready\\n");
          while (!(await Bun.file(start).exists())) await Bun.sleep(10);
          await withStateFileLock(
            sharedState(root),
            "counter",
            async () => {
              const value = Number((await Bun.file(counter).text()).trim());
              await Bun.sleep(20);
              await Bun.write(counter, String(value + 1) + "\\n");
            },
            { leaseMs: 30_000, heartbeatMs: 5_000, waitMs: 30_000 },
          );
          await Bun.write(complete, "complete\\n");
        `;
        const readyMarkers = Array.from({ length: 8 }, (_, index) => ({
          file: path.join(root, `worker-${index}-ready`),
          label: `worker-${index}-ready`,
        }));
        const completeMarkers = Array.from({ length: 8 }, (_, index) => ({
          file: path.join(root, `worker-${index}-complete`),
          label: `worker-${index}-complete`,
        }));
        const workers: OwnedSubprocess[] = [];
        try {
          for (const [index, ready] of readyMarkers.entries()) {
            workers.push(
              spawnOwned([
                process.execPath,
                "-e",
                code,
                root,
                counter,
                ready.file,
                start,
                completeMarkers[index]!.file,
              ]),
            );
          }
          await waitForMarkers(readyMarkers, MARKER_TIMEOUT_MS);
          await Bun.write(start, "start\n");
          await waitForMarkers(completeMarkers, RENEWAL_TIMEOUT_MS);
          const results = await settleOwnedSubprocesses(
            workers,
            ALL_WORKER_EXIT_TIMEOUT_MS,
            "eight-worker-exit",
          );
          expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
          expect((await readFile(counter, "utf8")).trim()).toBe("8");
        } finally {
          try {
            await Bun.write(start, "start\n");
          } finally {
            await settleOwnedSubprocesses(
              workers,
              ALL_WORKER_EXIT_TIMEOUT_MS,
              "eight-worker-exit",
              true,
            );
          }
        }
      } finally {
        await removeTestRoot(root);
      }
    },
    120_000,
  );

  test("concurrent initialization preserves one immutable manifest identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-init-processes-"));
    try {
      await Promise.all(Array.from({ length: 16 }, () => ensureSharedState(sharedState(root))));
      const manifest = JSON.parse(await readFile(path.join(root, ".andromeda", "manifest.json"), "utf8")) as {
        schemaVersion: number;
        installId: string;
        machineId: string;
      };
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.installId).toBeTruthy();
      expect(manifest.machineId).toBeTruthy();
      expect((await readdir(path.join(root, ".andromeda"))).some((name) => name.includes(".tmp"))).toBe(false);
    } finally {
      await removeTestRoot(root);
    }
  });
});
