#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { javascriptPackageVersionIssues } from "./verify-single-product-versions.mjs";
import { inventoryIssues } from "./verify-test-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((relative) => fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile());

const issues = [];
issues.push(...inventoryIssues(root));
const requiredLayout = [
  "data",
  "packages/migrate/core",
  "packages/migrate/gateway",
  "packages/migrate/harness",
  "packages/migrate/inference",
  "packages/migrate/manager",
  "packages/mcp/migrate/skills",
  "packages/mcp/migrate/hooks",
  "packages/mcp/migrate/roles",
  "commands",
];
for (const relative of requiredLayout) {
  if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isDirectory()) {
    issues.push(`required repository root is missing: ${relative}`);
  }
}
for (const retired of ["packages/migrate/core/src", "packages/migrate/core/test", "packages/migrate/core/capabilities"]) {
  if (fs.statSync(path.join(root, retired), { throwIfNoEntry: false })) {
    issues.push(`retired nested repository root remains: ${retired}`);
  }
}

const nestedRepositoryMetadata = [
  /^packages\/(?:.*\/)?(?:\.agents|\.darkfactory|docs)(?:\/|$)/i,
  /^packages\/(?:.*\/)?(?:AGENTS|PRD)\.md$/i,
  // A component may carry exactly one contract README at its own root; anything
  // deeper is a package pretending to be its own repository again.
  // clients/ groups the client components one level deeper; each still owns
  // exactly one contract README at its own root.
  /^packages\/(?!clients\/)[a-z0-9-]+\/.+\/README\.md$/i,
  /^packages\/clients\/[a-z0-9-]+\/.+\/README\.md$/i,
];
// packages/migrate holds former standalone repositories verbatim, frozen for
// migration. Their original metadata is evidence and is not rewritten here;
// code leaves migrate by reimplementation against the sdk.
const migrateTree = /^packages\/(?:migrate|mcp\/migrate)(?:\/|$)/;
for (const relative of tracked) {
  if (migrateTree.test(relative)) continue;
  if (nestedRepositoryMetadata.some((pattern) => pattern.test(relative))) {
    issues.push(`package-local repository metadata or documentation is tracked: ${relative}`);
  }
}

const gitmodules = fs.readFileSync(path.join(root, ".gitmodules"), "utf8");
for (const match of gitmodules.matchAll(/^\s*path\s*=\s*(.+)\s*$/gm)) {
  const submodulePath = match[1].trim();
  if (!["data/", "packages/", "agents/"].some((prefix) => submodulePath.startsWith(prefix))) {
    issues.push(`managed repository submodule is outside data/, packages/, or agents/: ${submodulePath}`);
  }
}

const forbiddenPaths = [
  [/(^|\/)\.agents\/\.global(\/|$)/, "copied global agent state"],
  [/(^|\/)legacy(\/|$)/i, "legacy implementation tree"],
  [/^packages\/core\/src\/(?:plugin|dream)(\/|$)/, "retired provider-era memory plugin"],
  [/(^|\/)rommie\/v1(\/|$)/, "retired wire namespace"],
];
for (const relative of tracked) {
  if (migrateTree.test(relative)) continue;
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
  "packages/migrate/manager/src/runtime-paths.ts",
  "packages/migrate/manager/src/state-doctor.ts",
  "packages/migrate/manager/test/state.test.ts",
]);

// This policy file necessarily spells the retired identifiers it rejects.
// Product source, manifests, scripts, and documentation remain fully scanned.
// The CI inventory necessarily names the frozen packages/migrate directories,
// which keep the original repository names they were retired under. Its schema,
// paths, suites, and gitlinks are enforced by verify-test-inventory instead.
const policyFiles = new Set(["scripts/verify-single-product.mjs", "ci/test-inventory.json"]);

for (const relative of tracked) {
  if (policyFiles.has(relative)) continue;
  // packages/migrate holds former standalone repositories verbatim as frozen
  // evidence, and those histories necessarily spell the names they were retired
  // for. Retired-name enforcement stays fully active on every surface that is
  // still built, imported, or shipped; nothing imports migrate.
  if (migrateTree.test(relative)) continue;
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
if (rootPackage.name !== "@marius-patrik/agents-manager") {
  issues.push("root package.json must remain the recorded @marius-patrik/agents-manager package-name exception");
}
if (rootPackage.bin?.agents !== "./packages/migrate/manager/src/cli.ts") {
  issues.push("root package.json must own the authoritative agents CLI entrypoint");
}

const expectedJavaScriptWorkspaces = new Map([
  ["packages/migrate/manager/package.json", "@marius-patrik/andromeda-manager"],
  ["packages/migrate/core/clients/shared-ts/package.json", "@agent-os/shared-ts"],
  ["packages/migrate/core/clients/tui/package.json", "@agent-os/tui"],
  ["packages/migrate/core/clients/web/package.json", "@agent-os/web"],
]);
const declaredWorkspaces = new Set(rootPackage.workspaces ?? []);
for (const required of ["packages/migrate/manager", "packages/migrate/core/clients/*"]) {
  if (!declaredWorkspaces.has(required)) issues.push(`root package.json does not own workspace pattern: ${required}`);
}
for (const [relative, expectedName] of expectedJavaScriptWorkspaces) {
  if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()) {
    issues.push(`required JavaScript workspace metadata is missing: ${relative}`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  if (manifest.name !== expectedName) issues.push(`JavaScript package name drift in ${relative}: ${manifest.name} != ${expectedName}`);
}
for (const relative of tracked.filter(
  (name) =>
    name.startsWith("packages/") &&
    !migrateTree.test(name) &&
    name.endsWith("package.json") &&
    !name.endsWith("agent.package.json"),
)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  if (manifest.private !== true) issues.push(`nested JavaScript package must be private implementation metadata: ${relative}`);
  if (manifest.bin?.agents) issues.push(`nested JavaScript package competes for the agents CLI entrypoint: ${relative}`);
  if (typeof manifest.description !== "string" || !manifest.description.trim()) {
    issues.push(`nested JavaScript package must describe its PRD layer: ${relative}`);
  }
}

for (const retired of [
  "docs/specs/clients/shared-ts.md",
  "docs/specs/clients/tui.md",
  "docs/specs/clients/web.md",
]) {
  if (fs.statSync(path.join(root, retired), { throwIfNoEntry: false })) {
    issues.push(`retired competing client specification remains: ${retired}`);
  }
}

const manifests = [];
for (const relative of tracked.filter((name) => name.endsWith("agent.package.json") && !migrateTree.test(name))) {
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

// Frozen former repositories keep the versions they were released at; the
// single-product version contract governs what is still built and shipped.
const versionedTracked = tracked.filter((name) => !migrateTree.test(name));
issues.push(...javascriptPackageVersionIssues(root, versionedTracked, productVersion));
for (const relative of versionedTracked.filter((name) => name.endsWith("pyproject.toml"))) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  const version = text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version && version !== productVersion) issues.push(`Python package version drift in ${relative}: ${version} != ${productVersion}`);
}

if (issues.length) {
  for (const issue of [...new Set(issues)].sort()) console.error(`error: ${issue}`);
  process.exit(1);
}

console.log(`Single Agent OS product contract verified at version ${productVersion}.`);
