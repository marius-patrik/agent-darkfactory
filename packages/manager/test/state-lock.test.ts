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

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for test subprocess marker: ${file}`);
}

describe("canonical mutable-state locks", () => {
  test("transient database contention delays verification without forfeiting ownership", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-busy-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const lock = await acquireRenewableStateLock(state, "race:busy", {
        leaseMs: 2_000,
        heartbeatMs: 1_500,
        waitMs: 50,
      });
      const ready = path.join(root, "blocker-ready");
      const code = `
        import { Database } from "bun:sqlite";
        const database = new Database(process.argv[1]);
        database.exec("BEGIN EXCLUSIVE");
        await Bun.write(process.argv[2], "ready\\n");
        Bun.sleepSync(250);
        database.exec("COMMIT");
        database.close();
      `;
      const blocker = Bun.spawn(
        [process.execPath, "-e", code, renewableLockDatabasePath(state), ready],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        await waitForFile(ready);
        await lock.verify();
        const [codeResult, stderr] = await Promise.all([
          blocker.exited,
          new Response(blocker.stderr).text(),
        ]);
        expect({ code: codeResult, stderr }).toEqual({ code: 0, stderr: "" });
      } finally {
        blocker.kill();
        await blocker.exited;
        await lock.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("database contention cannot revive a lease after its confirmed expiry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-busy-expiry-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const lock = await acquireRenewableStateLock(state, "race:busy-expiry", {
        leaseMs: 600,
        heartbeatMs: 500,
        waitMs: 1_000,
      });
      const ready = path.join(root, "expiry-blocker-ready");
      const code = `
        import { Database } from "bun:sqlite";
        const database = new Database(process.argv[1]);
        database.exec("BEGIN EXCLUSIVE");
        await Bun.write(process.argv[2], "ready\\n");
        Bun.sleepSync(800);
        database.exec("COMMIT");
        database.close();
      `;
      const blocker = Bun.spawn(
        [process.execPath, "-e", code, renewableLockDatabasePath(state), ready],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        await waitForFile(ready);
        await expect(lock.verify()).rejects.toThrow("ownership was lost");
        const [codeResult, stderr] = await Promise.all([
          blocker.exited,
          new Response(blocker.stderr).text(),
        ]);
        expect({ code: codeResult, stderr }).toEqual({ code: 0, stderr: "" });

        const successor = await acquireRenewableStateLock(state, "race:busy-expiry", {
          leaseMs: 1_000,
          heartbeatMs: 100,
          waitMs: 1_000,
        });
        await successor.verify();
        await successor.release();
      } finally {
        blocker.kill();
        await blocker.exited;
        await lock.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("heartbeat holds one writer beyond the nominal lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-heartbeat-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const order: string[] = [];
      const options = { leaseMs: 500, heartbeatMs: 50, waitMs: 3_000 };
      const first = withStateFileLock(
        state,
        "probe",
        async () => {
          order.push("first:entered");
          await new Promise((resolve) => setTimeout(resolve, 800));
          order.push("first:leaving");
        },
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = withStateFileLock(state, "probe", async () => order.push("second:entered"), options);
      await Promise.all([first, second]);
      expect(order).toEqual(["first:entered", "first:leaving", "second:entered"]);
      const database = new Database(renewableLockDatabasePath(state), { readonly: true });
      try {
        const row = database.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM renewable_leases WHERE key = 'state:probe'",
        ).get();
        expect(row?.count).toBe(0);
      } finally {
        database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("a paused subprocess cannot delete its successor during stale release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-aba-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const ready = path.join(root, "owner-ready");
      const outcome = path.join(root, "owner-outcome");
      const stateModule = new URL("../src/state.ts", import.meta.url).href;
      const lockModule = new URL("../src/state-lock.ts", import.meta.url).href;
      const code = `
        import { sharedState } from ${JSON.stringify(stateModule)};
        import { acquireRenewableStateLock } from ${JSON.stringify(lockModule)};
        const state = sharedState(process.argv[1]);
        const lock = await acquireRenewableStateLock(state, "race:aba", {
          leaseMs: 100,
          heartbeatMs: 20,
          waitMs: 1_000,
          owner: "paused-owner",
        });
        await Bun.write(process.argv[2], "ready\\n");
        Bun.sleepSync(300);
        let result = "unexpectedly-verified";
        try {
          await lock.verify();
        } catch (error) {
          result = error instanceof Error ? error.message : String(error);
        }
        await lock.release();
        await Bun.write(process.argv[3], result + "\\n");
      `;
      const worker = Bun.spawn([process.execPath, "-e", code, root, ready, outcome], {
        stdout: "pipe",
        stderr: "pipe",
      });

      await waitForFile(ready);
      await Bun.sleep(130);
      const successor = await acquireRenewableStateLock(state, "race:aba", {
        leaseMs: 1_000,
        heartbeatMs: 100,
        waitMs: 1_000,
        owner: "successor",
      });
      try {
        const [codeResult, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stderr).text(),
        ]);
        expect(codeResult).toBe(0);
        expect(stderr).toBe("");
        expect((await readFile(outcome, "utf8")).trim()).toContain("ownership was lost");

        await successor.verify();
        await expect(
          acquireRenewableStateLock(state, "race:aba", {
            leaseMs: 1_000,
            heartbeatMs: 100,
            waitMs: 50,
            owner: "denied-third-owner",
          }),
        ).rejects.toThrow("timed out waiting for canonical renewable lock");
      } finally {
        await successor.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("an expired owner fails closed and cannot renew itself", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-expired-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const lock = await acquireRenewableStateLock(state, "race:expired", {
        leaseMs: 80,
        heartbeatMs: 20,
        waitMs: 1_000,
      });
      Bun.sleepSync(120);
      await expect(lock.verify()).rejects.toThrow("ownership was lost");
      await lock.release();

      const replacement = await acquireRenewableStateLock(state, "race:expired", {
        leaseMs: 500,
        heartbeatMs: 50,
        waitMs: 1_000,
      });
      await replacement.verify();
      await replacement.release();
      expect(await Bun.file(renewableLockDatabasePath(state)).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("independent processes cannot lose read-modify-write updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-lock-processes-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const counter = path.join(state.stateDir, "counter.txt");
      await Bun.write(counter, "0\n");
      const stateModule = new URL("../src/state.ts", import.meta.url).href;
      const lockModule = new URL("../src/state-lock.ts", import.meta.url).href;
      const code = `
        import { sharedState } from ${JSON.stringify(stateModule)};
        import { withStateFileLock } from ${JSON.stringify(lockModule)};
        const root = process.argv[1];
        const counter = process.argv[2];
        await withStateFileLock(sharedState(root), "counter", async () => {
          const value = Number((await Bun.file(counter).text()).trim());
          await new Promise((resolve) => setTimeout(resolve, 20));
          await Bun.write(counter, String(value + 1) + "\\n");
        });
      `;
      const workers = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, "-e", code, root, counter], { stdout: "pipe", stderr: "pipe" }),
      );
      const results = await Promise.all(
        workers.map(async (worker) => ({
          code: await worker.exited,
          stderr: await new Response(worker.stderr).text(),
        })),
      );
      expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
      expect((await readFile(counter, "utf8")).trim()).toBe("8");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("concurrent initialization preserves one immutable manifest identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-init-processes-"));
    try {
      await Promise.all(Array.from({ length: 16 }, () => ensureSharedState(sharedState(root))));
      const manifest = JSON.parse(await readFile(path.join(root, ".agents", "manifest.json"), "utf8")) as {
        schemaVersion: number;
        installId: string;
        machineId: string;
      };
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.installId).toBeTruthy();
      expect(manifest.machineId).toBeTruthy();
      expect((await readdir(path.join(root, ".agents"))).some((name) => name.includes(".tmp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
