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
  "src/sdk/tests",
  "src/server/gateway",
  "src/sdk/harness",
  "src/server/inference",
  "src/cli",
  ".agents/capabilities/global/skills",
  ".agents/capabilities/global/hooks",
  ".agents/capabilities/global/roles",
  ".agents/capabilities/global/commands",
];
for (const relative of requiredLayout) {
  if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isDirectory()) {
    issues.push(`required repository root is missing: ${relative}`);
  }
}
const nestedRepositoryMetadata = [
  // No config or state root belongs inside a component tree, in any era:
  // .agents is the current repository config root and the state root name,
  // .andromeda the retired state root, .darkfactory the name every other
  // managed repository still uses.
  /^packages\/(?!\.project\/)(?:.*\/)?(?:\.agents|\.andromeda|\.darkfactory|docs)(?:\/|$)/i,
  /^packages\/(?!\.project\/)(?:.*\/)?(?:AGENTS|PRD)\.md$/i,
  // A component may carry exactly one contract README at its own root; anything
  // deeper is a package pretending to be its own repository again. The clients
  // no longer group one level deeper, so the grouped form this rule used to
  // carve out is gone and the single component-depth rule covers every package.
  /^packages\/[a-z0-9-]+\/.+\/README\.md$/i,
];
// src/bot carries the folded DarkFactory repository verbatim, with its own
// identity and versioning. Repository-wide contracts on what is built and
// shipped do not apply inside it; every live surface stays fully scanned.
const carriedPackageTree = /^src\/bot(?:\/|$)/;
// agents/ holds agent projects, and templates/ holds folded template repositories,
// versioning, and project docs. Like bot, they are carried rather than
// built as part of this product, so the single-product interior rules do not
// apply inside them. Every live surface remains fully scanned.
const agentsTree = /^templates\/[^/]+\//;
const carriedTree = (relative) => carriedPackageTree.test(relative) || agentsTree.test(relative);
for (const relative of tracked) {
  if (carriedTree(relative)) continue;
  if (nestedRepositoryMetadata.some((pattern) => pattern.test(relative))) {
    issues.push(`package-local repository metadata or documentation is tracked: ${relative}`);
  }
}

const gitmodules = fs.readFileSync(path.join(root, ".gitmodules"), "utf8");
for (const match of gitmodules.matchAll(/^\s*path\s*=\s*(.+)\s*$/gm)) {
  const submodulePath = match[1].trim();
  if (!["src/"].some((prefix) => submodulePath === prefix || submodulePath.startsWith(prefix))) {
    issues.push(`managed repository submodule is outside src/: ${submodulePath}`);
  }
}

const forbiddenPaths = [
  // .agents/capabilities/global at the repository root is the authored
  // capability floor. A copy of it anywhere below the root is a leaked config
  // or state home, so every spelling it has had is rejected when nested: the
  // current one, the dot-prefixed form it used before the floor was
  // un-prefixed, and the retired .andromeda state root.
  [/.+\/\.agents\/capabilities\/global(\/|$)/, "copied global agent state"],
  [/.+\/\.agents\/\.global(\/|$)/, "copied global agent state"],
  [/.+\/\.andromeda\/\.global(\/|$)/, "copied global agent state"],
  [/(^|\/)legacy(\/|$)/i, "legacy implementation tree"],
  [/^packages\/core\/src\/(?:plugin|dream)(\/|$)/, "retired provider-era memory plugin"],
  [/(^|\/)rommie\/v1(\/|$)/, "retired wire namespace"],
];
for (const relative of tracked) {
  if (carriedTree(relative)) continue;
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

// Files allowed to spell a retired state variable, because rejecting it is
// their job. AGENTS_ joined ROMMIE_ and AGENTOS_ when the environment contract
// became ANDROMEDA_; capabilities.ts is here because it keeps the retired state
// root names in its forbidden-tree-segment set, the way it already kept
// .rommie.
const retiredVariableRejectionFiles = new Set([
  "install/install.sh",
  "src/cli/capabilities.ts",
  "src/cli/runtime-paths.ts",
  "src/cli/state-doctor.ts",
  "src/cli/test/state.test.ts",
]);

// This policy file necessarily spells the retired identifiers it rejects.
// Product source, manifests, scripts, and documentation remain fully scanned.
// The CI inventory necessarily names carried directories that keep the original
// repository names they were retired under. Its schema, paths, suites, and
// gitlinks are enforced by verify-test-inventory instead.
const policyFiles = new Set(["scripts/verify-single-product.mjs", ".github/ci/test-inventory.json"]);

for (const relative of tracked) {
  if (policyFiles.has(relative)) continue;
  // Carried trees hold folded repositories verbatim as frozen evidence, and
  // those histories necessarily spell the names they were retired for.
  // Retired-name enforcement stays fully active on every surface that is still
  // built, imported, or shipped; nothing imports a carried tree.
  if (carriedTree(relative)) continue;
  const absolute = path.join(root, relative);
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [pattern, label] of retiredContent) {
    if (pattern.test(text)) issues.push(`${label} remains in ${relative}`);
  }
  if (/\b(?:ROMMIE_|AGENTOS_|AGENTS_)[A-Z0-9_]*\b/.test(text) && !retiredVariableRejectionFiles.has(relative)) {
    issues.push(`retired state variable occurs outside its explicit rejection boundary: ${relative}`);
  }
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productVersion = rootPackage.version;
if (typeof productVersion !== "string" || !productVersion) issues.push("root package.json must declare the product version");
// The agents-manager exception is retired: the root package carries the product
// name, and every component follows it as andromeda-<component>.
if (rootPackage.name !== "@marius-patrik/andromeda") {
  issues.push("root package.json must be named @marius-patrik/andromeda");
}
if (rootPackage.bin?.andromeda !== "./src/cli/cli.ts") {
  issues.push("root package.json must own the authoritative andromeda CLI entrypoint");
}
// Nothing may reintroduce the retired agents command as a bin alias.
if (rootPackage.bin?.agents) {
  issues.push("root package.json reintroduces the retired agents CLI alias");
}

// One package, no workspaces: the product is a single @marius-patrik/andromeda
// manifest at the root with src/ as its source tree. A nested manifest would
// mean a component had started publishing itself again.
const nestedManifests = tracked.filter((name) => name.startsWith("src/") && name.endsWith("package.json") && !name.endsWith("agent.package.json") && !carriedTree(name));
for (const relative of nestedManifests) {
  issues.push(`src/ must hold no nested JavaScript package manifest: ${relative}`);
}
if (Array.isArray(rootPackage.workspaces) && rootPackage.workspaces.length > 0) {
  issues.push("root package.json must not declare workspaces: the product is one package");
}
for (const relative of tracked.filter(
  (name) =>
    name.startsWith("src/") &&
    !carriedTree(name) &&
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
for (const relative of tracked.filter((name) => name.endsWith("agent.package.json") && !carriedTree(name))) {
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
const versionedTracked = tracked.filter((name) => !carriedTree(name));
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
