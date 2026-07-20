import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { runPromptLibrarySyncCli } from "../scripts/sync-prompt-library.js";
import { syncPromptLibrary } from "../src/prompt-sync.js";
import { loadManifest, verifySnapshots } from "../src/prompts.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const promptsRoot = resolve(testDir, "../prompts");

function waitForChildOutput(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    let errors = "";
    const onStdout = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        cleanup();
        resolveOutput();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      errors += chunk.toString("utf8");
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectOutput(new Error(`lock-holder process exited ${code} before ${marker}: ${errors || output}`));
    };
    const cleanup = (): void => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function captureTree(root: string): Array<[string, string]> {
  const captured: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const fullPath = join(directory, entry);
      const stat = lstatSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        captured.push([
          relative(root, fullPath).replaceAll("\\", "/"),
          readFileSync(fullPath, "utf8")
        ]);
      } else {
        captured.push([relative(root, fullPath).replaceAll("\\", "/"), `mode:${stat.mode}`]);
      }
    }
  };
  visit(root);
  return captured;
}

test("sync module imports without executing the CLI", () => {
  assert.equal(typeof runPromptLibrarySyncCli, "function");
  assert.equal(existsSync(join(promptsRoot, ".sync.lock")), false);
});

test("a drifted isolated copy aborts before any live prompt-library write", async () => {
  const parent = mkdtempSync(join(tmpdir(), "df-prompt-sync-test-"));
  const liveRoot = join(parent, "prompts");
  try {
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });
    const before = captureTree(liveRoot);
    let hookRan = false;

    await assert.rejects(
      syncPromptLibrary(liveRoot, {
          afterCopy: ({ stageRoot }) => {
            hookRan = true;
            writeFileSync(
              join(stageRoot, "roles", "planner.md"),
              "# Copy drift that must never reach live publication\n",
              "utf8"
            );
          }
        }),
      /Prompt-library live source does not match isolated stage: roles\/planner\.md/
    );

    assert.equal(hookRan, true);
    assert.deepEqual(captureTree(liveRoot), before);
    assert.equal(existsSync(join(liveRoot, ".sync.lock")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("the OS-owned lock excludes concurrent same-root syncs and releases after errors", async () => {
  const parent = mkdtempSync(join(tmpdir(), "df-prompt-sync-lock-"));
  const liveRoot = join(parent, "prompts");
  let releaseHold!: () => void;
  let reportLocked!: () => void;
  const hold = new Promise<void>((resolveHold) => { releaseHold = resolveHold; });
  const locked = new Promise<void>((resolveLocked) => { reportLocked = resolveLocked; });
  try {
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });
    const first = syncPromptLibrary(liveRoot, {
      afterLock: async () => {
        reportLocked();
        await hold;
      }
    });
    await locked;
    await assert.rejects(syncPromptLibrary(liveRoot), /sync lock unavailable/);
    releaseHold();
    await first;

    await assert.rejects(
      syncPromptLibrary(liveRoot, { afterLock: () => { throw new Error("injected lock-holder failure"); } }),
      /injected lock-holder failure/
    );
    await assert.doesNotReject(syncPromptLibrary(liveRoot));
  } finally {
    releaseHold?.();
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("the global lock excludes direct and UNC aliases across processes", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "df-prompt-sync-alias-lock-"));
  const liveRoot = join(parent, "prompts");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });
    const match = /^([A-Za-z]):\\(.*)$/.exec(resolve(liveRoot));
    assert.ok(match, `expected a drive-rooted Windows path: ${liveRoot}`);
    const uncRoot = `\\\\localhost\\${match[1].toLowerCase()}$\\${match[2]}`;
    if (!existsSync(uncRoot)) {
      t.skip("the host does not expose the local drive through its administrative UNC share");
      return;
    }

    const moduleUrl = pathToFileURL(resolve(testDir, "../src/prompt-sync.ts")).href;
    const holder = [
      `const { syncPromptLibrary } = await import(${JSON.stringify(moduleUrl)});`,
      `await syncPromptLibrary(${JSON.stringify(liveRoot)}, {`,
      "  afterLock: async () => {",
      "    process.stdout.write('LOCKED\\n');",
      "    await new Promise((resolveHold) => process.stdin.once('data', resolveHold));",
      "  }",
      "});"
    ].join("\n");
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", holder], {
      cwd: resolve(testDir, ".."),
      stdio: ["pipe", "pipe", "pipe"]
    });
    await waitForChildOutput(child, "LOCKED");

    await assert.rejects(syncPromptLibrary(uncRoot), /sync lock unavailable/);
    const exited = new Promise<number | null>((resolveExit) => child!.once("exit", resolveExit));
    child.stdin.end("release\n");
    const exitCode = await exited;
    assert.equal(exitCode, 0);
    child = undefined;
  } finally {
    if (child !== undefined) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
        child.stdin.end("release\n");
        child.kill();
        await exited;
      }
    }
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("the global lock excludes a replacement root reached through a different alias", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "df-prompt-sync-replacement-lock-"));
  const liveRoot = join(parent, "prompts");
  const movedRoot = join(parent, "prompts-admitted");
  let releaseHold!: () => void;
  let reportLocked!: () => void;
  const hold = new Promise<void>((resolveHold) => { releaseHold = resolveHold; });
  const locked = new Promise<void>((resolveLocked) => { reportLocked = resolveLocked; });
  try {
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });
    const match = /^([A-Za-z]):\\(.*)$/.exec(resolve(liveRoot));
    assert.ok(match, `expected a drive-rooted Windows path: ${liveRoot}`);
    const uncRoot = `\\\\localhost\\${match[1].toLowerCase()}$\\${match[2]}`;
    if (!existsSync(uncRoot)) {
      t.skip("the host does not expose the local drive through its administrative UNC share");
      return;
    }

    const first = syncPromptLibrary(liveRoot, {
      afterLock: async () => {
        reportLocked();
        await hold;
      }
    });
    await locked;
    renameSync(liveRoot, movedRoot);
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });

    let secondEntered = false;
    await assert.rejects(
      syncPromptLibrary(uncRoot, { afterLock: () => { secondEntered = true; } }),
      /sync lock unavailable/
    );
    assert.equal(secondEntered, false);

    releaseHold();
    await assert.rejects(first, /root changed after sync-lock admission/);
    await assert.doesNotReject(syncPromptLibrary(liveRoot));
  } finally {
    releaseHold?.();
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("sync restores a partial live manifest from its durable recovery copy", async () => {
  const parent = mkdtempSync(join(tmpdir(), "df-prompt-sync-recovery-"));
  const liveRoot = join(parent, "prompts");
  try {
    cpSync(promptsRoot, liveRoot, { recursive: true, dereference: false });
    await syncPromptLibrary(liveRoot);
    writeFileSync(join(liveRoot, "manifest.json"), '{"schemaVersion": 1,');

    const result = await syncPromptLibrary(liveRoot);
    assert.equal(result.artifactCount, 62);
    assert.equal(result.fixtureCount, 16);
    assert.equal(loadManifest(liveRoot).library, "darkfactory-prompts");
    assert.doesNotThrow(() => verifySnapshots(liveRoot));
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
