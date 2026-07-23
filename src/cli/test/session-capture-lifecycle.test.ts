import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedState, type SharedState } from "../state";
import {
  buildSessionCaptureTaskSpec,
  createWindowsSessionCaptureScheduler,
  installSessionCapture,
  sessionCaptureWrapperPath,
  uninstallSessionCapture,
  type SessionCaptureScheduler,
  type SessionCaptureTaskInfo,
  type SessionCaptureTaskSpec,
} from "../session-capture-lifecycle";

const SYSTEM_ROOT = "C:\\Windows";
const PRINCIPAL = "ACME\\patrik";

function canonicalTask(
  spec: SessionCaptureTaskSpec,
  overrides: Partial<SessionCaptureTaskInfo> = {},
): SessionCaptureTaskInfo {
  return {
    name: spec.name,
    path: spec.path,
    enabled: true,
    actionCount: 1,
    executable: spec.executable,
    arguments: spec.arguments,
    triggerCount: 1,
    interval: spec.interval,
    hidden: true,
    multipleInstances: "IgnoreNew",
    principalUser: spec.principalUser,
    logonType: "Interactive",
    runLevel: "Limited",
    executionLimit: spec.executionLimit,
    ...overrides,
  };
}

async function fixture(): Promise<{ root: string; state: SharedState }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-capture-lifecycle-"));
  const state = sharedState(root);
  await ensureSharedState(state);
  await mkdir(path.join(state.stateDir, "bin"), { recursive: true });
  await writeFile(path.join(state.stateDir, "bin", "andromeda.ps1"), "exit 0\n");
  return { root, state };
}

function lifecycleOptions(scheduler: SessionCaptureScheduler) {
  return {
    platform: "win32" as const,
    systemRoot: SYSTEM_ROOT,
    principal: () => PRINCIPAL,
    scheduler,
  };
}

describe("scheduled desktop-session capture lifecycle regression triplet", () => {
  test("success: keeps the hidden wrapper outside the launcher-only bin and installs idempotently", async () => {
    const { root, state } = await fixture();
    try {
      let task: SessionCaptureTaskInfo | null = null;
      let installs = 0;
      const scheduler: SessionCaptureScheduler = {
        query: async () => task,
        install: async (spec) => {
          installs += 1;
          task = canonicalTask(spec);
        },
        uninstall: async () => {
          task = null;
        },
      };

      const first = await installSessionCapture(state, lifecycleOptions(scheduler));
      const second = await installSessionCapture(state, lifecycleOptions(scheduler));

      expect(first.healthy).toBe(true);
      expect(second.healthy).toBe(true);
      expect(installs).toBe(1);
      expect(sessionCaptureWrapperPath(state)).toBe(
        path.join(state.stateDir, "runtime", "session-capture", "session-capture.vbs"),
      );
      expect((await readdir(path.join(state.stateDir, "bin"))).sort()).toEqual(["andromeda.ps1"]);
      expect(await readFile(sessionCaptureWrapperPath(state), "utf8")).toContain("shell.Run(command, 0, True)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("edge input: refuses to overwrite or uninstall a same-name task with a noncanonical definition", async () => {
    const { root, state } = await fixture();
    try {
      const spec = buildSessionCaptureTaskSpec(state, PRINCIPAL, SYSTEM_ROOT);
      const task = canonicalTask(spec, { executable: "C:\\Other\\unowned.exe" });
      let installCalls = 0;
      let uninstallCalls = 0;
      const scheduler: SessionCaptureScheduler = {
        query: async () => task,
        install: async () => {
          installCalls += 1;
        },
        uninstall: async () => {
          uninstallCalls += 1;
        },
      };

      await expect(installSessionCapture(state, lifecycleOptions(scheduler))).rejects.toThrow(
        "refusing to overwrite noncanonical scheduled session capture task",
      );
      await expect(uninstallSessionCapture(state, lifecycleOptions(scheduler))).rejects.toThrow(
        "refusing to uninstall noncanonical scheduled session capture task",
      );
      expect(installCalls).toBe(0);
      expect(uninstallCalls).toBe(0);
      await expect(lstat(sessionCaptureWrapperPath(state))).rejects.toMatchObject({ code: "ENOENT" });

      const scripts: string[] = [];
      const backend = createWindowsSessionCaptureScheduler(async (script) => {
        scripts.push(script);
        return { code: 0, stdout: "", stderr: "" };
      });
      await backend.install(spec);
      await backend.uninstall(spec);
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).not.toContain("-Force");
      expect(scripts[1]).toContain("action ownership drifted");
      expect(scripts[1]).toContain("principal ownership drifted");
      expect(scripts[1]).toContain("Unregister-ScheduledTask");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied failure: rolls back only the newly created task and restores the prior wrapper", async () => {
    const { root, state } = await fixture();
    try {
      const wrapperPath = sessionCaptureWrapperPath(state);
      await mkdir(path.dirname(wrapperPath), { recursive: true });
      await writeFile(wrapperPath, "prior wrapper\n");
      let task: SessionCaptureTaskInfo | null = null;
      let uninstallCalls = 0;
      const scheduler: SessionCaptureScheduler = {
        query: async () => task,
        install: async (spec) => {
          task = canonicalTask(spec, { enabled: false });
        },
        uninstall: async () => {
          uninstallCalls += 1;
          task = null;
        },
      };

      await expect(installSessionCapture(state, lifecycleOptions(scheduler))).rejects.toThrow(
        "scheduled session capture postcondition failed",
      );
      expect(task).toBeNull();
      expect(uninstallCalls).toBe(1);
      expect(await readFile(wrapperPath, "utf8")).toBe("prior wrapper\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
