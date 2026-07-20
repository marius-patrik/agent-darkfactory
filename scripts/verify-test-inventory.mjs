#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_SUITE_NAMES } from "./run-ci-suite.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sortedDirectories(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${relative}/${entry.name}`.replaceAll("\\", "/"))
    .sort();
}

function unique(values) {
  return [...new Set(values)];
}

// Managed repositories live under data/ (state), packages/ (components), and
// agents/ (agent projects built on packages/agent).
const MANAGED_REPOSITORY_PREFIXES = ["src/"];

export function parseIndexedGitlinks(output) {
  return output
    .split("\0")
    .map((entry) => {
      const separator = entry.indexOf("\t");
      const metadata = separator < 0 ? null : entry.slice(0, separator).match(/^160000 [0-9a-f]+ ([0-3])$/);
      if (!metadata) return undefined;
      return { path: entry.slice(separator + 1), stage: Number(metadata[1]) };
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage);
}

function indexedGitlinks(root) {
  return parseIndexedGitlinks(execFileSync("git", ["-C", root, "ls-files", "--stage", "-z"]).toString("utf8"));
}

function declaredSubmodulePaths(root) {
  const gitmodulesPath = path.join(root, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) return [];
  let output = "";
  try {
    output = execFileSync("git", [
      "config",
      "-z",
      "--file",
      gitmodulesPath,
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]).toString("utf8");
  } catch (error) {
    return [];
  }
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      if (separator < 0) throw new Error("git config returned a malformed submodule path record");
      return entry.slice(separator + 1);
    });
}

function workflowHasLeg(workflow, suite, runner) {
  const escapedSuite = suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRunner = runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`-\\s+suite:\\s*${escapedSuite}\\s*\\r?\\n\\s+runner:\\s*${escapedRunner}(?:\\s|$)`).test(workflow);
}

export function inventoryIssues(root = repositoryRoot) {
  const issues = [];
  const inventoryPath = path.join(root, "ci", "test-inventory.json");
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (inventory.schemaVersion !== 1) issues.push("ci/test-inventory.json must use schemaVersion 1");

  const groups = [
    ...(Array.isArray(inventory.activeComponents) ? inventory.activeComponents : []),
    ...(Array.isArray(inventory.realBehaviorLegs) ? inventory.realBehaviorLegs : []),
    ...(Array.isArray(inventory.productSmokes) ? inventory.productSmokes : []),
    ...(Array.isArray(inventory.supportingSuites) ? inventory.supportingSuites : []),
  ];
  const activeComponents = Array.isArray(inventory.activeComponents) ? inventory.activeComponents : [];
  const parkedPlugins = Array.isArray(inventory.parkedPlugins) ? inventory.parkedPlugins : [];
  const parkedApps = Array.isArray(inventory.parkedApps) ? inventory.parkedApps : [];
  // Components scaffolded for the target architecture that hold only their
  // contract README. Declaring them keeps the fail-closed rule intact: the
  // moment one gains code it must also gain a suite.
  const scaffoldedComponents = Array.isArray(inventory.scaffoldedComponents) ? inventory.scaffoldedComponents : [];

  const ids = groups.map((entry) => entry.id);
  const duplicateIds = unique(ids.filter((id, index) => ids.indexOf(id) !== index));
  for (const id of duplicateIds) issues.push(`duplicate CI inventory id: ${id}`);

  const declaredSuites = groups.map((entry) => entry.suite);
  const duplicateSuites = unique(declaredSuites.filter((suite, index) => declaredSuites.indexOf(suite) !== index));
  for (const suite of duplicateSuites) issues.push(`duplicate CI suite assignment: ${suite}`);
  for (const suite of CI_SUITE_NAMES) {
    if (!declaredSuites.includes(suite)) issues.push(`CI runner suite is not declared in inventory: ${suite}`);
  }
  for (const suite of declaredSuites) {
    if (!CI_SUITE_NAMES.includes(suite)) issues.push(`inventory references an unknown CI runner suite: ${suite}`);
  }

  const declaredPackages = [
    ...activeComponents.map((entry) => entry.path),
    ...parkedPlugins,
    ...parkedApps,
    ...scaffoldedComponents,
  ]
    .filter((entry) => typeof entry === "string" && (["sdk", "mcp", "hooks", "roles", "skills"].includes(entry) || entry.startsWith("src/")))
    .sort();
  // packages/migrate nests one level deeper: its children are frozen former
  // components, each still individually declared in the inventory.
  const actualPackages = [
    ...sortedDirectories(root, "src"),
    ...sortedDirectories(root, "src/migrate"),
    ...(fs.existsSync(path.join(root, "sdk")) ? ["sdk"] : []),
    ...(fs.existsSync(path.join(root, "mcp")) ? ["mcp"] : []),
    ...(fs.existsSync(path.join(root, "hooks")) ? ["hooks"] : []),
    ...(fs.existsSync(path.join(root, "roles")) ? ["roles"] : []),
    ...(fs.existsSync(path.join(root, "skills")) ? ["skills"] : []),
  ].sort();
  for (const packagePath of actualPackages) {
    if (!declaredPackages.includes(packagePath)) issues.push(`package has no fail-closed CI inventory entry: ${packagePath}`);
  }
  for (const packagePath of declaredPackages) {
    if (!actualPackages.includes(packagePath)) issues.push(`CI inventory package is missing: ${packagePath}`);
  }

  const declaredGitlinks = declaredSubmodulePaths(root);
  const actualGitlinks = indexedGitlinks(root);
  for (const declaredPath of declaredGitlinks) {
    if (!MANAGED_REPOSITORY_PREFIXES.some((prefix) => declaredPath.startsWith(prefix))) {
      issues.push(`managed repository declaration is outside data/, packages/, or agents/: ${declaredPath}`);
    }
  }
  for (const gitlink of actualGitlinks) {
    if (!MANAGED_REPOSITORY_PREFIXES.some((prefix) => gitlink.path.startsWith(prefix))) {
      issues.push(`managed repository gitlink is outside data/, packages/, or agents/: ${gitlink.path}`);
    }
  }
  const activeGitlinks = activeComponents
    .filter((entry) => entry.submodule === true)
    .map((entry) => entry.path)
    .filter((entry) => typeof entry === "string");
  const classifications = [
    { label: "active", paths: activeGitlinks },
    { label: "parked plugin", paths: parkedPlugins.filter((entry) => typeof entry === "string") },
    { label: "parked application", paths: parkedApps.filter((entry) => typeof entry === "string") },
  ];
  for (const classification of classifications) {
    for (const managedPath of unique(classification.paths)) {
      if (classification.paths.filter((entry) => entry === managedPath).length > 1) {
        issues.push(`managed package is repeated in the ${classification.label} CI classification: ${managedPath}`);
      }
    }
  }
  for (const managedPath of unique(classifications.flatMap((entry) => entry.paths))) {
    const memberships = classifications.filter((entry) => entry.paths.includes(managedPath)).map((entry) => entry.label);
    if (memberships.length > 1) {
      issues.push(`managed package has conflicting CI classifications (${memberships.join(", ")}): ${managedPath}`);
    }
  }
  const isManagedComponentPath = (value) => value.startsWith("src/") || value.startsWith("agents/");
  const declaredPackageGitlinks = declaredGitlinks.filter(isManagedComponentPath).sort();
  const actualPackageGitlinks = actualGitlinks.filter((entry) => isManagedComponentPath(entry.path));
  const classifiedPackageGitlinks = [...activeGitlinks, ...parkedPlugins, ...parkedApps]
    .filter(isManagedComponentPath)
    .sort();
  const managedPackagePaths = unique([
    ...declaredPackageGitlinks,
    ...actualPackageGitlinks.map((entry) => entry.path),
    ...classifiedPackageGitlinks,
  ]).sort();
  for (const managedPath of managedPackagePaths) {
    if (!/^(?:packages\/(?:migrate\/)?|agents\/)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(managedPath)) {
      issues.push(`managed component path is not a lowercase child of packages/, packages/migrate/, or agents/: ${managedPath}`);
    }
    const declarationCount = declaredPackageGitlinks.filter((entry) => entry === managedPath).length;
    const gitlinks = actualPackageGitlinks.filter((entry) => entry.path === managedPath);
    const classified = classifiedPackageGitlinks.includes(managedPath);
    if ((declarationCount > 0 || gitlinks.length > 0) && !classified) {
      issues.push(`managed package is neither active nor parked in CI inventory: ${managedPath}`);
    }
    if (gitlinks.length > 0 && declarationCount === 0) {
      issues.push(`managed package gitlink is not declared in .gitmodules: ${managedPath}`);
    }
    if (classified && declarationCount === 0) {
      issues.push(`classified managed package is not declared in .gitmodules: ${managedPath}`);
    }
    if (declarationCount > 1) issues.push(`managed package is declared multiple times: ${managedPath}`);
    if (classified && gitlinks.length === 0) {
      issues.push(`classified managed package is not a repository gitlink: ${managedPath}`);
    }
    if (gitlinks.length > 1) issues.push(`managed package has multiple index entries: ${managedPath}`);
    if (gitlinks.some((entry) => entry.stage !== 0)) {
      issues.push(`managed package has unmerged index entries: ${managedPath}`);
    }
  }

  const allowedDataGitlinks = [];
  const declaredDataGitlinks = declaredGitlinks.filter((entry) => entry.startsWith("data/")).sort();
  const actualDataGitlinks = actualGitlinks.filter((entry) => entry.path.startsWith("data/"));
  for (const declaredPath of declaredDataGitlinks) {
    if (!allowedDataGitlinks.includes(declaredPath)) issues.push(`data repository declaration is not allowlisted: ${declaredPath}`);
  }
  for (const gitlink of actualDataGitlinks) {
    if (!allowedDataGitlinks.includes(gitlink.path)) issues.push(`data repository gitlink is not allowlisted: ${gitlink.path}`);
  }
  for (const allowedPath of allowedDataGitlinks) {
    const declarationCount = declaredDataGitlinks.filter((entry) => entry === allowedPath).length;
    const gitlinks = actualDataGitlinks.filter((entry) => entry.path === allowedPath);
    if (declarationCount === 0) issues.push(`allowlisted data repository is not declared in .gitmodules: ${allowedPath}`);
    if (declarationCount > 1) issues.push(`allowlisted data repository is declared multiple times: ${allowedPath}`);
    if (gitlinks.length === 0) issues.push(`allowlisted data repository is not a repository gitlink: ${allowedPath}`);
    if (gitlinks.length > 1) issues.push(`allowlisted data repository has multiple index entries: ${allowedPath}`);
    if (gitlinks.some((entry) => entry.stage !== 0)) issues.push(`allowlisted data repository has unmerged index entries: ${allowedPath}`);
  }

  for (const entry of groups) {
    if (typeof entry.id !== "string" || !entry.id) issues.push("CI inventory entry is missing an id");
    if (typeof entry.suite !== "string" || !entry.suite) issues.push(`CI inventory entry ${entry.id ?? "(unknown)"} is missing a suite`);
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      issues.push(`CI inventory entry ${entry.id ?? "(unknown)"} has no platform leg`);
    }
    for (const requiredPath of entry.requiredPaths ?? []) {
      if (!fs.statSync(path.join(root, requiredPath), { throwIfNoEntry: false })?.isFile()) {
        issues.push(`CI inventory entry ${entry.id} is missing required suite path: ${requiredPath}`);
      }
    }
  }

  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  for (const entry of groups) {
    for (const runner of entry.platforms ?? []) {
      if (!workflowHasLeg(workflow, entry.suite, runner)) {
        issues.push(`CI workflow omits inventory leg ${entry.suite} on ${runner}`);
      }
    }
  }
  if (!/^\s+name:\s+Validate\s*$/m.test(workflow)) issues.push("CI workflow must preserve the required Validate context");
  if (!/^\s+name:\s+Repository contract\s*$/m.test(workflow)) {
    issues.push("CI workflow must preserve the exact repository contract job");
  }
  if (!/^\s+needs:\s*\r?\n\s+-\s+suites\s*\r?\n\s+-\s+repository-contract\s*$/m.test(workflow)) {
    issues.push("Validate must aggregate every suite matrix leg and the repository contract");
  }
  if (!/^\s+if:\s+\$\{\{\s*always\(\)\s*\}\}\s*$/m.test(workflow)) {
    issues.push("Validate must run even when a suite fails so omission cannot look green");
  }
  return issues;
}

export function assertTestInventory(root = repositoryRoot) {
  const issues = inventoryIssues(root);
  if (issues.length) throw new Error(issues.join("\n"));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    assertTestInventory();
    console.log("Whole-monorepo CI inventory is complete and wired fail-closed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
