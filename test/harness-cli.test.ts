import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

async function runAgents(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
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
          "  AGENTS_BIN: process.env.AGENTS_BIN,",
          "  AGENTS_BIN_SCRIPT: process.env.AGENTS_BIN_SCRIPT,",
          "  AGENTS_HOME: process.env.AGENTS_HOME,",
          "  AGENTS_ROOT: process.env.AGENTS_ROOT,",
          "  AGENTS_DATA: process.env.AGENTS_DATA,",
          "  AGENTS_WORKSPACE: process.env.AGENTS_WORKSPACE,",
          "  AGENTS_CLIS: process.env.AGENTS_CLIS,",
          "  AGENTS_CREDITS: process.env.AGENTS_CREDITS,",
          "  AGENTS_DATA_REPOS: process.env.AGENTS_DATA_REPOS,",
          "  AGENTOS_DATA_ROOT: process.env.AGENTOS_DATA_ROOT,",
          "  ROMMIE_HOME: process.env.ROMMIE_HOME,",
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
      expect(env.AGENTS_BIN).toBe(process.execPath);
      expect(env.AGENTS_BIN_SCRIPT).toBe(cliPath);
      expect(env.AGENTS_HOME).toBe(path.join(root, ".agents"));
      expect(env.AGENTS_ROOT).toBe(root);
      expect(env.AGENTS_DATA).toBe(path.join(root, "data"));
      expect(env.AGENTS_WORKSPACE).toBe(path.join(root, "os", "agents-workspace"));
      expect(env.AGENTS_CLIS).toBe(path.join(root, ".agents", "clis"));
      expect(env.AGENTS_CREDITS).toBe(path.join(root, ".agents", "credits.json"));
      expect(env.AGENTS_DATA_REPOS).toBe(path.join(root, ".agents", "data-repos.json"));
      expect(env.AGENTOS_DATA_ROOT).toBe(path.join(root, "data", "data-agentos"));
      expect(env.ROMMIE_HOME).toBe(path.join(root, ".agents", "harnesses", "probe", "runtime"));
      expect(JSON.stringify(env.passthrough)).toBe(JSON.stringify(["--probe"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs packages with shared Agentos environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-package-run-"));
    try {
      const pkg = path.join(root, "probe-package");
      await mkdir(pkg, { recursive: true });
      await Bun.write(
        path.join(pkg, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "probe-package",
          kind: "agent",
          entry: `${process.execPath} cli.ts`,
          requires: { state: ["secrets", "credits"] },
        }),
      );
      await Bun.write(
        path.join(pkg, "cli.ts"),
        [
          "const out = Bun.argv[2];",
          "await Bun.write(out, JSON.stringify({",
          "  AGENTS_HOME: process.env.AGENTS_HOME,",
          "  AGENTS_ROOT: process.env.AGENTS_ROOT,",
          "  AGENTS_DATA: process.env.AGENTS_DATA,",
          "  AGENTS_WORKSPACE: process.env.AGENTS_WORKSPACE,",
          "  AGENTS_SECRETS: process.env.AGENTS_SECRETS,",
          "  AGENTS_DATA_REPOS: process.env.AGENTS_DATA_REPOS,",
          "  AGENTOS_DATA_ROOT: process.env.AGENTOS_DATA_ROOT,",
          "  DARK_FACTORY_WORKSPACE_ROOT: process.env.DARK_FACTORY_WORKSPACE_ROOT,",
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
        "darkfactory-workspace",
        "marius-patrik/agentos-data",
        "--path",
        "data/data-agentos",
        "--managed-path",
        "managed-repository",
        "--env",
        "DARK_FACTORY_WORKSPACE_ROOT",
      ]);
      expect(dataRepo.code).toBe(0);

      const output = path.join(root, "package-env.json");
      const run = await runAgents(root, ["packages", "run", "probe-package", "--", output, "--probe"]);
      expect(run.code).toBe(0);

      const env = JSON.parse(await Bun.file(output).text()) as Record<string, unknown>;
      expect(env.AGENTS_HOME).toBe(path.join(root, ".agents"));
      expect(env.AGENTS_ROOT).toBe(root);
      expect(env.AGENTS_DATA).toBe(path.join(root, "data"));
      expect(env.AGENTS_WORKSPACE).toBe(path.join(root, "os", "agents-workspace"));
      expect(env.AGENTS_SECRETS).toBe(path.join(root, ".agents", "secrets"));
      expect(env.AGENTS_DATA_REPOS).toBe(path.join(root, ".agents", "data-repos.json"));
      expect(env.AGENTOS_DATA_ROOT).toBe(path.join(root, "data", "data-agentos"));
      expect(env.DARK_FACTORY_WORKSPACE_ROOT).toBe(path.join(root, "data", "data-agentos", "managed-repository"));
      expect(JSON.stringify(env.args)).toBe(JSON.stringify(["--probe"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cli exec honors inherited AGENTS_HOME from non-root cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-cli-env-"));
    try {
      const subdir = path.join(root, "nested", "cwd");
      const binDir = path.join(root, "bin");
      await mkdir(subdir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const output = path.join(root, "codex-env.json");
      const codex = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      if (process.platform === "win32") {
        await Bun.write(codex, `@echo off\r\necho CODEX_HOME=%CODEX_HOME% > "${output}"\r\necho args=%* >> "${output}"\r\n`);
      } else {
        await Bun.write(codex, `#!/bin/sh\nprintf 'CODEX_HOME=%s\\nargs=%s\\n' "$CODEX_HOME" "$*" > "${output}"\n`);
        await Bun.$`chmod +x ${codex}`;
      }

      const stateHome = path.join(root, ".agents");
      const run = await runAgents(subdir, ["cli", "exec", "codex", "--", "--probe"], {
        AGENTS_HOME: stateHome,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      expect(run.code).toBe(0);

      const seen = Object.fromEntries(
        (await Bun.file(output).text())
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const [key, value = ""] = line.split("=", 2);
            return [key, value.trim()];
          }),
      ) as Record<string, string>;
      expect(seen.CODEX_HOME).toBe(path.join(stateHome, "clis", "codex"));
      expect(seen.args).toBe("--probe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


