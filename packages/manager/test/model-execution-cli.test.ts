import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelExecutionRequestFromCli, selectsModelExecution } from "../src/model-execution-cli";
import { canonicalChildEnvironment } from "../src/runtime-paths";
import { ensureSharedState, sharedStateAt, writeSessionConfig, type SharedState } from "../src/state";

const cliPath = path.resolve(import.meta.dir, "..", "src", "cli.ts");
const repositoryRoot = path.resolve(import.meta.dir, "..", "..", "..");
const installerPath = path.join(repositoryRoot, "install", "install.sh");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-model-cli-"));
  roots.push(root);
  return root;
}

async function executionFixture(): Promise<{
  root: string;
  state: SharedState;
  receiptDir: string;
}> {
  const container = await rootFixture();
  const root = path.join(container, "workspace with spaces");
  const userHome = path.join(container, "user home");
  const state = sharedStateAt(root, path.join(userHome, ".agents"), userHome);
  const receiptDir = path.join(root, "receipt folder");
  await mkdir(receiptDir, { recursive: true });
  await ensureSharedState(state);
  await writeSessionConfig(state, {
    schemaVersion: 1,
    providerModels: { codex: ["gpt-5.6-sol"] },
  });
  return { root, state, receiptDir };
}

async function splitExecutionFixture(): Promise<{
  distributionRoot: string;
  workdir: string;
  state: SharedState;
  receiptDir: string;
}> {
  const container = await rootFixture();
  const distributionRoot = path.join(container, "agent os distribution");
  const workdir = path.join(container, "caller worktree");
  const userHome = path.join(container, "user home");
  const state = sharedStateAt(distributionRoot, path.join(userHome, ".agents"), userHome);
  const receiptDir = path.join(workdir, ".darkfactory");
  await mkdir(distributionRoot, { recursive: true });
  await mkdir(receiptDir, { recursive: true });
  await ensureSharedState(state);
  await writeSessionConfig(state, {
    schemaVersion: 1,
    providerModels: { codex: ["gpt-5.6-sol"] },
  });
  return { distributionRoot, workdir, state, receiptDir };
}

function executionEnv(state: SharedState): Record<string, string | undefined> {
  return {
    ...canonicalChildEnvironment(process.env),
    AGENTS_HOME: state.stateDir,
    AGENTS_USER_HOME: state.userHome,
    AGENTS_ROOT: state.root,
    AGENTS_WORKSPACE: state.workspaceDir,
    AGENTS_SYSTEM_DATA_ROOT: state.stateDir,
  };
}

async function runProcess(
  argv: string[],
  root: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function readBlockedReceipt(receiptPath: string): Promise<{
  requested: { modelTier: string; effort: string };
  resolved: { provider: string; model: string };
  outcome: string;
  blockReason: string;
}> {
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

async function installWindowsLauncher(state: SharedState): Promise<string> {
  const gitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  const child = Bun.spawn(
    [gitBash, "-lc", 'source "$(cygpath -u "$ANDROMEDA_INSTALL_SCRIPT")"; install_launcher'],
    {
      cwd: repositoryRoot,
      env: {
        ...canonicalChildEnvironment(process.env),
        ANDROMEDA_INSTALL_SCRIPT: installerPath,
        AGENTS_HOME: state.stateDir,
        AGENTS_USER_HOME: state.userHome,
        AGENTS_ROOT: state.root,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`launcher installation failed (${code}): ${stdout}${stderr}`);
  return path.join(state.stateDir, "bin", "agents.ps1");
}

function flags(root: string): Record<string, string | boolean> {
  return {
    "model-tier": "high",
    effort: "high",
    "execution-policy": "read-only",
    receipt: path.join(root, "receipt.json"),
    mode: "orchestrator",
  };
}

describe("model execution CLI prompt boundary", () => {
  test("positional prompt produces the canonical independent-axis request", async () => {
    const root = await rootFixture();
    const request = await modelExecutionRequestFromCli({
      values: ["review this"],
      flags: flags(root),
      workdir: root,
    });
    expect(request).toEqual({
      modelTier: "high",
      effort: "high",
      executionPolicy: "read-only",
      receiptPath: path.join(root, "receipt.json"),
      workdir: await realpath(root),
      mode: "orchestrator",
      prompt: "review this",
      promptSource: "positional",
    });
  });

  test("prompt file and stdin keep the full context out of CLI values", async () => {
    const root = await rootFixture();
    const promptPath = path.join(root, "large-review.txt");
    const prompt = "TRUSTED_REVIEW_CONTEXT\n".repeat(1024);
    await writeFile(promptPath, prompt);
    const fromFile = await modelExecutionRequestFromCli({
      values: [],
      flags: { ...flags(root), "prompt-file": promptPath },
      workdir: root,
    });
    expect(fromFile.prompt).toBe(prompt);
    expect(fromFile.promptSource).toBe("file");

    const fromStdin = await modelExecutionRequestFromCli({
      values: [],
      flags: { ...flags(root), "prompt-stdin": true },
      workdir: root,
      stdin: Readable.from(["first", " second"]),
    });
    expect(fromStdin.prompt).toBe("first second");
    expect(fromStdin.promptSource).toBe("stdin");
  });

  test("multiple, missing, and malformed prompt sources fail closed", async () => {
    const root = await rootFixture();
    await expect(
      modelExecutionRequestFromCli({ values: ["review", "this"], flags: flags(root), workdir: root }),
    ).rejects.toThrow("positional prompt must be exactly one value");
    await expect(
      modelExecutionRequestFromCli({ values: [], flags: flags(root), workdir: root }),
    ).rejects.toThrow("exactly one prompt source");
    await expect(
      modelExecutionRequestFromCli({
        values: ["positional"],
        flags: { ...flags(root), "prompt-stdin": true },
        workdir: root,
        stdin: Readable.from(["stdin"]),
      }),
    ).rejects.toThrow("exactly one prompt source");
    await expect(
      modelExecutionRequestFromCli({
        values: [],
        flags: { ...flags(root), "prompt-stdin": "yes" },
        workdir: root,
      }),
    ).rejects.toThrow("does not take a value");
    await expect(
      modelExecutionRequestFromCli({ values: ["prompt"], flags: { ...flags(root), mode: "unsafe" }, workdir: root }),
    ).rejects.toThrow("--mode is invalid");
    const interactive = Object.assign(Readable.from(["should not be read"]), { isTTY: true });
    await expect(
      modelExecutionRequestFromCli({
        values: [],
        flags: { ...flags(root), "prompt-stdin": true },
        workdir: root,
        stdin: interactive,
      }),
    ).rejects.toThrow("requires piped input");
  });

  test("required policy flags remain explicit rather than silently defaulting", async () => {
    const root = await rootFixture();
    for (const name of ["model-tier", "effort", "execution-policy", "receipt"]) {
      const incomplete = flags(root);
      delete incomplete[name];
      await expect(
        modelExecutionRequestFromCli({ values: ["prompt"], flags: incomplete, workdir: root }),
      ).rejects.toThrow(`run requires --${name}`);
    }
    expect(selectsModelExecution({ effort: "high" })).toBe(true);
    expect(selectsModelExecution({ "execution-policy": "workspace-write" })).toBe(true);
    expect(selectsModelExecution({ receipt: path.join(root, "receipt.json") })).toBe(true);
    expect(selectsModelExecution({ provider: "codex", model: "gpt-5.6-sol" })).toBe(false);
    await expect(
      modelExecutionRequestFromCli({
        values: [],
        flags: {
          effort: "high",
          "execution-policy": "read-only",
          receipt: path.join(root, "receipt.json"),
          "prompt-file": path.join(root, "missing-sensitive-input.txt"),
        },
        workdir: root,
      }),
    ).rejects.toThrow("run requires --model-tier");
  });

  test("logical tier selection rejects direct route and TUI overrides", async () => {
    const root = await rootFixture();
    for (const name of ["provider", "model", "agent", "agent-preset", "tui"]) {
      await expect(
        modelExecutionRequestFromCli({
          values: ["prompt"],
          flags: { ...flags(root), [name]: name === "tui" ? true : "override" },
          workdir: root,
        }),
      ).rejects.toThrow(`cannot be combined with --${name}`);
    }
  });

  test("physical workdir admission canonicalizes an invocation path alias", async () => {
    const container = await rootFixture();
    const physical = path.join(container, "physical worktree");
    const alias = path.join(container, "worktree alias");
    await mkdir(physical, { recursive: true });
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const request = await modelExecutionRequestFromCli({
      values: ["review this"],
      flags: flags(physical),
      workdir: alias,
    });

    expect(request.workdir).toBe(await realpath(physical));
    expect(request.workdir).not.toBe(alias);
  });

  test("logical tier selection rejects unknown executable, registry, and fallback controls", async () => {
    const root = await rootFixture();
    for (const name of ["executable", "registry", "fallback"]) {
      await expect(
        modelExecutionRequestFromCli({
          values: ["prompt"],
          flags: { ...flags(root), [name]: "override" },
          workdir: root,
        }),
      ).rejects.toThrow(`does not accept --${name}`);
    }
  });

  test("agents run routes the complete logical-tier contract and emits only a stable block", async () => {
    const { root, state, receiptDir } = await executionFixture();
    const receiptPath = path.join(receiptDir, "direct receipt.json");
    const prompt = "DIRECT_TIER_PROMPT_SENTINEL";
    const result = await runProcess(
      [
        process.execPath,
        cliPath,
        "run",
        "--model-tier",
        "high",
        "--effort",
        "low",
        "--execution-policy",
        "read-only",
        "--receipt",
        receiptPath,
        "--mode",
        "task",
        prompt,
      ],
      root,
      executionEnv(state),
    );
    const receipt = await readBlockedReceipt(receiptPath);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(`execution blocked: ${receipt.blockReason}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(prompt);
    expect(receipt.requested).toEqual({ modelTier: "high", effort: "low" });
    expect(receipt.resolved).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(receipt.outcome).toBe("blocked");
  });

  test("partial logical-tier flags cannot fall through to legacy provider execution", async () => {
    const { root, state, receiptDir } = await executionFixture();
    const receiptPath = path.join(receiptDir, "must not exist.json");
    const result = await runProcess(
      [
        process.execPath,
        cliPath,
        "run",
        "--effort",
        "low",
        "--execution-policy",
        "read-only",
        "--receipt",
        receiptPath,
        "prompt",
      ],
      root,
      executionEnv(state),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("agents: run requires --model-tier");
    await expect(readFile(receiptPath, "utf8")).rejects.toThrow();

    const policyOnly = await runProcess(
      [
        process.execPath,
        cliPath,
        "run",
        "--execution-policy",
        "workspace-write",
        "prompt",
      ],
      root,
      executionEnv(state),
    );
    expect(policyOnly.code).toBe(1);
    expect(policyOnly.stdout).toBe("");
    expect(policyOnly.stderr.trim()).toBe("agents: run requires --model-tier");
  });

  test("agents run keeps receipt authority in the caller worktree when AGENTS_ROOT differs", async () => {
    const { distributionRoot, workdir, state, receiptDir } = await splitExecutionFixture();
    const receiptPath = path.join(receiptDir, "caller receipt.json");
    const result = await runProcess(
      [
        process.execPath,
        cliPath,
        "run",
        "--model-tier",
        "high",
        "--effort",
        "low",
        "--execution-policy",
        "read-only",
        "--receipt",
        receiptPath,
        "caller-root sentinel",
      ],
      workdir,
      executionEnv(state),
    );
    const receipt = await readBlockedReceipt(receiptPath);

    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(`execution blocked: ${receipt.blockReason}`);
    expect(receipt.outcome).toBe("blocked");
    expect(receiptPath.startsWith(`${workdir}${path.sep}`)).toBe(true);
    expect(receiptPath.startsWith(`${distributionRoot}${path.sep}`)).toBe(false);
  });

  test("agents run rejects a receipt under AGENTS_ROOT when the caller worktree differs", async () => {
    const { distributionRoot, workdir, state } = await splitExecutionFixture();
    const receiptDir = path.join(distributionRoot, ".darkfactory");
    const receiptPath = path.join(receiptDir, "distribution receipt.json");
    await mkdir(receiptDir, { recursive: true });
    const result = await runProcess(
      [
        process.execPath,
        cliPath,
        "run",
        "--model-tier",
        "high",
        "--effort",
        "low",
        "--execution-policy",
        "read-only",
        "--receipt",
        receiptPath,
        "outside-root sentinel",
      ],
      workdir,
      executionEnv(state),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("agents: execution receipt path must be inside the execution workdir");
    await expect(readFile(receiptPath, "utf8")).rejects.toThrow();
  });

  test("installed Windows PowerShell launcher preserves the full contract through @args", async () => {
    if (process.platform !== "win32") return;
    const container = await rootFixture();
    const root = path.join(container, "caller worktree with spaces");
    const userHome = path.join(container, "user home");
    const state = sharedStateAt(repositoryRoot, path.join(userHome, ".agents"), userHome);
    const receiptDir = path.join(root, "receipt folder");
    await mkdir(receiptDir, { recursive: true });
    await ensureSharedState(state);
    await writeSessionConfig(state, {
      schemaVersion: 1,
      providerModels: { codex: ["gpt-5.6-sol"] },
    });
    const launcherPath = await installWindowsLauncher(state);
    const promptPath = path.join(root, "prompt source with spaces.txt");
    const receiptPath = path.join(receiptDir, "launcher receipt with spaces.json");
    const prompt = "WINDOWS_LAUNCHER_PROMPT_SENTINEL";
    await writeFile(promptPath, prompt);
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = await runProcess(
      [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherPath,
        "run",
        "--model-tier",
        "high",
        "--effort",
        "low",
        "--execution-policy",
        "read-only",
        "--receipt",
        receiptPath,
        "--mode",
        "task",
        "--prompt-file",
        promptPath,
      ],
      root,
      executionEnv(state),
    );
    const receipt = await readBlockedReceipt(receiptPath);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(`execution blocked: ${receipt.blockReason}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(prompt);
    expect(receipt.requested).toEqual({ modelTier: "high", effort: "low" });
    expect(receipt.resolved).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(receipt.outcome).toBe("blocked");
  });
});
