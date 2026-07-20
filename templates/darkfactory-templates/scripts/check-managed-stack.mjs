#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repos = [
  { path: ".", name: "darkfactory-templates" },
  { path: "templates/template-bot", name: "template-bot" },
  { path: "templates/template-cli", name: "template-cli" },
  { path: "templates/template-repo", name: "template-repo" },
  { path: "templates/template-web", name: "template-web" },
];

let allOk = true;

for (const repo of repos) {
  console.log(`\n${repo.name}: managed stack verification`);

  if (!existsSync(repo.path)) {
    console.error(`  missing repo path (${repo.path}); run \`git submodule update --init --recursive\``);
    allOk = false;
    continue;
  }

  const verifier = join(repo.path, ".github", "scripts", "dark-factory-release-check.mjs");
  if (!existsSync(verifier)) {
    console.error("  missing: .github/scripts/dark-factory-release-check.mjs");
    allOk = false;
    continue;
  }

  const result = spawnSync(
    process.execPath,
    [".github/scripts/dark-factory-release-check.mjs", "--mode", "managed"],
    {
      cwd: repo.path,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    allOk = false;
  }
}

if (!allOk) {
  console.error("\nManaged stack verification failed.");
  process.exit(1);
}

console.log("\nManaged stack verification passed.");
