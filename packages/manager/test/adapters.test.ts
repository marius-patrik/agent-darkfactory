import { describe, expect, test } from "bun:test";
import { commandInvocation } from "../src/process-command";
import path from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { adapterEnv, adapterHome, adapters, doctorAdapter, pinAdapter } from "../src/adapters";
import { sharedState, sharedStateAt } from "../src/state";

describe("CLI adapters", () => {
  test("builds platform-safe command invocations", () => {
    expect(commandInvocation("C:\\tools\\provider.ps1", ["--version"], {}, "win32")).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\tools\\provider.ps1",
      "--version",
    ]);
    expect(commandInvocation("C:\\tools\\provider.exe", ["--version"], {}, "win32")).toEqual([
      "C:\\tools\\provider.exe",
      "--version",
    ]);
    expect(commandInvocation("missing-provider", ["--version"], { PATH: "" }, "linux")).toEqual([
      "missing-provider",
      "--version",
    ]);
    expect(() => commandInvocation("C:\\tools\\provider.cmd", ["unsafe&arg"], {}, "win32")).toThrow(
      /batch command wrappers are not safe/,
    );
  });

  test("PowerShell wrappers preserve arbitrary arguments literally", async () => {
    if (process.platform !== "win32") return;

    const root = await mkdtemp(path.join(os.tmpdir(), "agents-powershell-args-"));
    const wrapper = path.join(root, "provider.ps1");
    const expected = [
      "space value",
      'quote"value',
      "%PATH%",
      "bang!value",
      "amp&pipe|less<than>greater^caret",
    ];

    try {
      await writeFile(
        wrapper,
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()\n[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n",
        "utf8",
      );
      const child = Bun.spawn(commandInvocation(wrapper, expected), {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("codex, claude, kimi, and agy expose rooted homes", () => {
    const state = sharedState(path.join("repo"));

    expect(Object.keys(adapters).sort()).toEqual(["agy", "claude", "codex", "kimi"]);
    expect(adapterEnv(state, "codex").CODEX_HOME).toBe(path.join(state.clisDir, "codex"));
    expect(adapterEnv(state, "codex").HOME).toBe(state.userHome);
    expect(adapterEnv(state, "codex").AGENTS_USER_HOME).toBe(state.userHome);
    expect(adapterEnv(state, "codex").AGENTS_MEMORY).toBe(path.join(state.stateDir, "memory"));
    expect(adapterEnv(state, "codex").AGENTS_ROOT).toBe(path.join("repo"));
    expect(adapterEnv(state, "codex").AGENTS_DATA).toBeUndefined();
    expect(adapterEnv(state, "codex").AGENTS_WORKSPACE).toBe(path.join("repo", ".agents", "runtime", "workspaces"));
    expect(adapterEnv(state, "codex").AGENTS_SECRETS).toBe(path.join(state.stateDir, "secrets"));
    expect(adapterEnv(state, "codex").AGENTS_DATA_REPOS).toBe(path.join(state.stateDir, "data-repos.json"));
    expect(adapterEnv(state, "codex").AGENTS_SYSTEM_DATA_ROOT).toBe(path.join("repo", "data", "agent-os"));
    expect(adapterEnv(state, "claude").CLAUDE_CONFIG_DIR).toBe(path.join(state.clisDir, "claude"));
    expect(adapterEnv(state, "kimi").KIMI_CODE_HOME).toBe(path.join(state.clisDir, "kimi"));
    expect(adapterEnv(state, "kimi").HOME).toBe(state.userHome);
    expect(adapterEnv(state, "agy").HOME).toBe(path.join(state.clisDir, "agy"));
  });

  test("credential paths exist only inside managed CLI homes", () => {
    const state = sharedState(path.join("repo"));

    expect(path.join(adapterHome(state, "codex"), adapters.codex.credentialPaths[0])).toBe(
      path.join(state.clisDir, "codex", "auth.json"),
    );
    expect(path.join(adapterHome(state, "claude"), adapters.claude.credentialPaths[0])).toBe(
      path.join(state.clisDir, "claude", ".credentials.json"),
    );
    expect(path.join(adapterHome(state, "kimi"), adapters.kimi.credentialPaths[0])).toBe(
      path.join(state.clisDir, "kimi", "credentials", "kimi-code.json"),
    );
    expect(path.join(adapterHome(state, "agy"), adapters.agy.credentialPaths[0])).toBe(
      path.join(state.clisDir, "agy", ".gemini", "oauth_creds.json"),
    );
  });

  test("doctor remains read-only and refuses an unpinned canonical binary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-adapter-"));
    try {
      const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
      await doctorAdapter(state, "codex");
      expect(await Bun.file(adapterHome(state, "codex")).exists()).toBe(false);

      const binary = path.join(adapterHome(state, "codex"), "bin", "codex");
      await Bun.write(binary, "#!/bin/sh\nexit 0\n");
      const found = await doctorAdapter(state, "codex");
      expect(found.binary).toBeNull();
      expect(found.ok).toBe(false);
      expect(found.notes.join("\n")).toContain("present but not pinned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins and verifies the real provider entrypoint", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-adapter-pin-"));
    try {
      const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
      const binary = path.join(adapterHome(state, "kimi"), "bin", "kimi");
      await Bun.write(binary, "#!/bin/sh\nprintf '0.23.4\\n'\n");
      await chmod(binary, 0o700);

      const registration = await pinAdapter(state, "kimi", binary);
      expect(registration.version).toBe("0.23.4");
      expect(registration.executable).toBe(binary);

      const healthy = await doctorAdapter(state, "kimi");
      expect(healthy.ok).toBe(true);
      expect(healthy.pinned).toBe(true);
      expect(healthy.binary).toBe(binary);

      await Bun.write(binary, "#!/bin/sh\nprintf 'changed\\n'\n");
      const drifted = await doctorAdapter(state, "kimi");
      expect(drifted.ok).toBe(false);
      expect(drifted.notes.join("\n")).toContain("checksum changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
