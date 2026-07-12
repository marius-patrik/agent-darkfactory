#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((relative) => fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile());

const issues = [];
const forbiddenPaths = [
  [/(^|\/)\.agents\/\.global(\/|$)/, "copied global agent state"],
  [/(^|\/)legacy(\/|$)/i, "legacy implementation tree"],
  [/^packages\/core\/src\/(?:plugin|dream)(\/|$)/, "retired provider-era memory plugin"],
  [/(^|\/)rommie\/v1(\/|$)/, "retired wire namespace"],
];
for (const relative of tracked) {
  for (const [pattern, label] of forbiddenPaths) {
    if (pattern.test(relative)) issues.push(`${label} is tracked: ${relative}`);
  }
}

const retiredContent = [
  [/\b(?:agentos|Agentos)\b/, "retired AgentOS product name"],
  [/\bagents-mono\b/i, "retired monorepo name"],
  [/\bdata-agentos\b/i, "retired data package name"],
  [/\bagentos-data\b/i, "retired data repository name"],
  [/\bagents-core\b/i, "retired core package name"],
  [/\binference-engine\b/i, "retired inference package name"],
  [/\bllm-gateway\b/i, "retired gateway package name"],
  [/\brommie\.v1\b/i, "retired wire package"],
  [/(^|["'`/])rommie\/v1(\/|["'`])/i, "retired wire path"],
  [/@agentos\//i, "retired JavaScript package scope"],
  [/github\.com\/marius-patrik\/agentos/i, "retired Go module root"],
  [/\bAGENTS_ORCH_[A-Z0-9_]*\b/, "retired orchestrator variable"],
  [/compatibility markers/i, "compatibility-marker contract"],
];

const retiredVariableRejectionFiles = new Set([
  "install/install.sh",
  "packages/core/src/manager/runtime-paths.ts",
  "packages/core/src/manager/state-doctor.ts",
  "packages/core/test/manager/state.test.ts",
]);

// This policy file necessarily spells the retired identifiers it rejects.
// Product source, manifests, scripts, and documentation remain fully scanned.
const policyFiles = new Set(["scripts/verify-single-product.mjs"]);

for (const relative of tracked) {
  if (policyFiles.has(relative)) continue;
  const absolute = path.join(root, relative);
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [pattern, label] of retiredContent) {
    if (pattern.test(text)) issues.push(`${label} remains in ${relative}`);
  }
  if (/\b(?:ROMMIE_|AGENTOS_)[A-Z0-9_]*\b/.test(text) && !retiredVariableRejectionFiles.has(relative)) {
    issues.push(`retired state variable occurs outside its explicit rejection boundary: ${relative}`);
  }
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productVersion = rootPackage.version;
if (typeof productVersion !== "string" || !productVersion) issues.push("root package.json must declare the product version");

const manifests = [];
for (const relative of tracked.filter((name) => name.endsWith("agent.package.json"))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  manifests.push({ relative, manifest });
  if (manifest.schemaVersion !== 1 || typeof manifest.id !== "string" || !manifest.id || manifest.kind === "agent") {
    issues.push(`invalid canonical package manifest: ${relative}`);
  }
}
const ids = new Map();
for (const { relative, manifest } of manifests) {
  const previous = ids.get(manifest.id);
  if (previous) issues.push(`duplicate package id ${manifest.id}: ${previous}, ${relative}`);
  ids.set(manifest.id, relative);
}

for (const relative of tracked.filter((name) => name.endsWith("package.json") && !name.endsWith("agent.package.json"))) {
  const value = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  if (typeof value.version === "string" && value.version !== productVersion) {
    issues.push(`JavaScript package version drift in ${relative}: ${value.version} != ${productVersion}`);
  }
}
for (const relative of tracked.filter((name) => name.endsWith("pyproject.toml"))) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  const version = text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version && version !== productVersion) issues.push(`Python package version drift in ${relative}: ${version} != ${productVersion}`);
}

if (issues.length) {
  for (const issue of [...new Set(issues)].sort()) console.error(`error: ${issue}`);
  process.exit(1);
}

console.log(`Single Agent OS product contract verified at version ${productVersion}.`);
