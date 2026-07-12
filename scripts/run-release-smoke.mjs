import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function releaseSmokeShell() {
  if (process.env.BASH) return process.env.BASH;
  if (process.platform !== "win32") return "bash";

  const programFiles = process.env.ProgramFiles;
  const candidates = programFiles
    ? [
        path.join(programFiles, "Git", "bin", "bash.exe"),
        path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
      ]
    : [];
  const shell = candidates.find(existsSync);
  if (!shell) {
    throw new Error("Git Bash is required for the Windows release smoke");
  }
  return shell;
}

const result = spawnSync(releaseSmokeShell(), [path.join(root, "install", "smoke-release.sh")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
