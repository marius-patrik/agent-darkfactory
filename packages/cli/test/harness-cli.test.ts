import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("ANDROMEDA_")) delete copy[key];
  }
  return copy;
}

async function runAgents(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: {
      ...cleanEnv(),
      ANDROMEDA_HOME: path.join(cwd, ".agents"),
      ANDROMEDA_USER_HOME: cwd,
      ANDROMEDA_ROOT: cwd,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("harness CLI", () => {
  test("runs harnesses with agents-owned environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-harness-"));
    try {
      const harness = path.join(root, "probe-harness");
      await mkdir(harness, { recursive: true });
      await Bun.write(
        path.join(harness, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "probe",
          kind: "harness",
          entry: `${process.execPath} probe.ts`,
          requires: { clis: [], state: ["skills", "plugins", "hooks", "credits"] },
        }),
      );
      await Bun.write(
        path.join(harness, "probe.ts"),
        [
          "import path from 'node:path';",
          "const out = Bun.argv[2];",
          "const passthrough = Bun.argv.slice(3);",
          "await Bun.write(out, JSON.stringify({",
          "  ANDROMEDA_BIN: process.env.ANDROMEDA_BIN,",
          "  ANDROMEDA_BIN_SCRIPT: process.env.ANDROMEDA_BIN_SCRIPT,",
          "  ANDROMEDA_HOME: process.env.ANDROMEDA_HOME,",
          "  ANDROMEDA_ROOT: process.env.ANDROMEDA_ROOT,",
          "  ANDROMEDA_DATA: process.env.ANDROMEDA_DATA,",
          "  ANDROMEDA_WORKSPACE: process.env.ANDROMEDA_WORKSPACE,",
          "  ANDROMEDA_CLIS: process.env.ANDROMEDA_CLIS,",
          "  ANDROMEDA_CREDITS: process.env.ANDROMEDA_CREDITS,",
          "  ANDROMEDA_DATA_REPOS: process.env.ANDROMEDA_DATA_REPOS,",
          "  ANDROMEDA_SYSTEM_DATA_ROOT: process.env.ANDROMEDA_SYSTEM_DATA_ROOT,",
          "  ANDROMEDA_HARNESS_HOME: process.env.ANDROMEDA_HARNESS_HOME,",
          "  passthrough,",
          "}));",
        ].join("\n"),
      );

      const register = await runAgents(root, ["packages", "register", harness]);
      expect(register.code).toBe(0);

      const output = path.join(root, "env.json");
      const run = await runAgents(root, ["harness", "run", "probe", "--", output, "--probe"]);
      expect(run.code).toBe(0);

      const env = JSON.parse(await Bun.file(output).text()) as Record<string, unknown>;
      expect(env.ANDROMEDA_BIN).toBe(process.execPath);
      expect(env.ANDROMEDA_BIN_SCRIPT).toBe(cliPath);
      expect(env.ANDROMEDA_HOME).toBe(path.join(root, ".agents"));
      expect(env.ANDROMEDA_ROOT).toBe(root);
      expect(env.ANDROMEDA_DATA).toBeUndefined();
      expect(env.ANDROMEDA_WORKSPACE).toBe(path.join(root, ".agents", "runtime", "workspaces"));
      expect(env.ANDROMEDA_CLIS).toBe(path.join(root, ".agents", "clis"));
      expect(env.ANDROMEDA_CREDITS).toBe(path.join(root, ".agents", "credits.json"));
      expect(env.ANDROMEDA_DATA_REPOS).toBe(path.join(root, ".agents", "data-repos.json"));
      expect(env.ANDROMEDA_SYSTEM_DATA_ROOT).toBe(path.join(root, ".agents"));
      expect(env.ANDROMEDA_HARNESS_HOME).toBe(path.join(root, ".agents", "harnesses", "probe", "runtime"));
      expect(JSON.stringify(env.passthrough)).toBe(JSON.stringify(["--probe"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs packages with the shared Agent OS environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-package-run-"));
    try {
      const pkg = path.join(root, "probe-package");
      await mkdir(pkg, { recursive: true });
      await Bun.write(
        path.join(pkg, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "probe-package",
          kind: "package",
          entry: `${process.execPath} cli.ts`,
          requires: { state: ["secrets", "credits"] },
        }),
      );
      await Bun.write(
        path.join(pkg, "cli.ts"),
        [
          "const out = Bun.argv[2];",
          "await Bun.write(out, JSON.stringify({",
          "  ANDROMEDA_HOME: process.env.ANDROMEDA_HOME,",
          "  ANDROMEDA_ROOT: process.env.ANDROMEDA_ROOT,",
          "  ANDROMEDA_DATA: process.env.ANDROMEDA_DATA,",
          "  ANDROMEDA_WORKSPACE: process.env.ANDROMEDA_WORKSPACE,",
          "  ANDROMEDA_SECRETS: process.env.ANDROMEDA_SECRETS,",
          "  ANDROMEDA_DATA_REPOS: process.env.ANDROMEDA_DATA_REPOS,",
          "  ANDROMEDA_SYSTEM_DATA_ROOT: process.env.ANDROMEDA_SYSTEM_DATA_ROOT,",
          "  PROJECT_DATA_ROOT: process.env.PROJECT_DATA_ROOT,",
          "  args: Bun.argv.slice(3),",
          "}));",
        ].join("\n"),
      );

      const register = await runAgents(root, ["packages", "register", pkg]);
      expect(register.code).toBe(0);
      const dataRepo = await runAgents(root, [
        "data",
        "repo",
        "set",
        "project-data",
        "marius-patrik/project-data",
        "--path",
        "data/project",
        "--env",
        "PROJECT_DATA_ROOT",
      ]);
      expect(dataRepo.code).toBe(0);

      const output = path.join(root, "package-env.json");
      const run = await runAgents(root, ["packages", "run", "probe-package", "--", output, "--probe"]);
      expect(run.code).toBe(0);

      const env = JSON.parse(await Bun.file(output).text()) as Record<string, unknown>;
      expect(env.ANDROMEDA_HOME).toBe(path.join(root, ".agents"));
      expect(env.ANDROMEDA_ROOT).toBe(root);
      expect(env.ANDROMEDA_DATA).toBeUndefined();
      expect(env.ANDROMEDA_WORKSPACE).toBe(path.join(root, ".agents", "runtime", "workspaces"));
      expect(env.ANDROMEDA_SECRETS).toBe(path.join(root, ".agents", "secrets"));
      expect(env.ANDROMEDA_DATA_REPOS).toBe(path.join(root, ".agents", "data-repos.json"));
      expect(env.ANDROMEDA_SYSTEM_DATA_ROOT).toBe(path.join(root, ".agents"));
      expect(env.PROJECT_DATA_ROOT).toBe(path.join(root, "data", "project"));
      expect(JSON.stringify(env.args)).toBe(JSON.stringify(["--probe"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cli pin uses only the canonical provider home and exposes no raw exec escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-cli-env-"));
    try {
      const subdir = path.join(root, "nested", "cwd");
      await mkdir(subdir, { recursive: true });
      const output = path.join(root, "codex-env.json");
      const stateHome = path.join(root, ".agents");
      const codex = path.join(
        stateHome,
        "clis",
        "codex",
        "bin",
        process.platform === "win32" ? "codex.ps1" : "codex",
      );
      if (process.platform === "win32") {
        await Bun.write(
          codex,
          `if ($args[0] -eq '--version') { Write-Output 'codex-test 1.0.0'; exit 0 }\n@("CODEX_HOME=$env:CODEX_HOME", "args=$($args -join ' ')") | Set-Content -LiteralPath '${output.replaceAll("'", "''")}'\n`,
        );
      } else {
        await Bun.write(
          codex,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'codex-test 1.0.0\\n'; exit 0; fi\nprintf 'CODEX_HOME=%s\\nargs=%s\\n' "$CODEX_HOME" "$*" > "${output}"\n`,
        );
        await Bun.$`chmod +x ${codex}`;
      }

      const pin = await runAgents(subdir, ["cli", "pin", "codex"], { ANDROMEDA_HOME: stateHome });
      expect(pin.code).toBe(0);
      const registry = JSON.parse(await Bun.file(path.join(stateHome, "providers.json")).text()) as {
        providers: { codex: { executable: string } };
      };
      expect(registry.providers.codex.executable).toBe(codex);

      const doctor = await runAgents(subdir, ["cli", "doctor", "codex"], { ANDROMEDA_HOME: stateHome });
      expect(doctor.code).toBe(0);
      expect(doctor.stdout).toContain(`binary=${codex}`);

      const rawExec = await runAgents(subdir, ["cli", "exec", "codex", "--", "--probe"], {
        ANDROMEDA_HOME: stateHome,
      });
      expect(rawExec.code).toBe(1);
      expect(rawExec.stderr).toContain("unknown cli action: exec");
      expect(await Bun.file(output).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
