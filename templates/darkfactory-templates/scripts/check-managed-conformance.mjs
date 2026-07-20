#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repos = [
  { path: ".", name: "darkfactory-templates" },
  { path: "templates/template-bot", name: "template-bot" },
  { path: "templates/template-cli", name: "template-cli" },
  { path: "templates/template-repo", name: "template-repo" },
  { path: "templates/template-web", name: "template-web" },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8").trim();
}

const managedConfigPath = ".darkfactory/managed-repository.json";
if (!existsSync(managedConfigPath)) {
  console.error(`Missing managed repository config: ${managedConfigPath}`);
  process.exit(1);
}

const config = readJson(managedConfigPath);
const requiredFiles = Array.isArray(config.requiredFiles) ? config.requiredFiles : [];
const expectedVersion = existsSync(".agents/.global/VERSION")
  ? readText(".agents/.global/VERSION")
  : null;

let allOk = true;

for (const repo of repos) {
  if (!existsSync(repo.path)) {
    console.error(`\n${repo.name}: missing repo path (${repo.path}); run \`git submodule update --init --recursive\``);
    allOk = false;
    continue;
  }

  const missing = [];
  const stale = [];

  for (const file of requiredFiles) {
    const fullPath = join(repo.path, file);
    if (!existsSync(fullPath)) {
      missing.push(file);
      continue;
    }

    if (file === ".agents/.global/VERSION" && expectedVersion) {
      const version = readText(fullPath);
      if (!version.startsWith("darkfactory-agent@")) {
        stale.push(`${file} (unexpected format: ${version})`);
      } else if (version !== expectedVersion) {
        stale.push(`${file} (expected ${expectedVersion}, got ${version})`);
      }
    }
  }

  // Account for repo-specific .agents/.project overlays: if a project overlay
  // exists, make sure it is a directory and not a file that would be clobbered
  // by managed sync.
  const projectOverlayPath = join(repo.path, ".agents", ".project");
  if (existsSync(projectOverlayPath) && !statSync(projectOverlayPath).isDirectory()) {
    stale.push(".agents/.project exists but is not a directory");
  }

  if (missing.length || stale.length) {
    allOk = false;
    console.error(`\n${repo.name}:`);
    for (const file of missing) {
      console.error(`  missing: ${file}`);
    }
    for (const file of stale) {
      console.error(`  stale: ${file}`);
    }
  } else {
    console.log(`\n${repo.name}: OK`);
  }
}

if (!allOk) {
  console.error("\nManaged-template conformance check failed.");
  process.exit(1);
}

console.log("\nManaged-template conformance check passed.");
