import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

const root = process.cwd();
const checkDirs = [
  { scripts: path.join(root, ".github", "scripts"), workflows: path.join(root, ".github", "workflows") }
];

for (const { scripts, workflows } of checkDirs) {
  for (const file of await filesWithExtension(scripts, ".mjs")) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: root,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      process.exitCode = result.status || 1;
      break;
    }
  }

  if (process.exitCode) break;

  for (const file of await filesWithExtension(workflows, ".yml")) {
    loadYaml(await readFile(file, "utf8"), { filename: file });
  }
}

async function filesWithExtension(dir, extension) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}
