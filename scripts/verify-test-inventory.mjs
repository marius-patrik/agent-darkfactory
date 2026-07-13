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

function indexedGitlinks(root) {
  return execFileSync("git", ["-C", root, "ls-files", "--stage", "-z"])
    .toString("utf8")
    .split("\0")
    .map((entry) => entry.match(/^160000 [0-9a-f]+ 0\t(.+)$/)?.[1])
    .filter((entry) => typeof entry === "string")
    .sort();
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

  const declaredPackages = activeComponents
    .map((entry) => entry.path)
    .filter((entry) => typeof entry === "string" && entry.startsWith("packages/"))
    .sort();
  const actualPackages = sortedDirectories(root, "packages");
  for (const packagePath of actualPackages) {
    if (!declaredPackages.includes(packagePath)) issues.push(`package has no fail-closed CI inventory entry: ${packagePath}`);
  }
  for (const packagePath of declaredPackages) {
    if (!actualPackages.includes(packagePath)) issues.push(`CI inventory package is missing: ${packagePath}`);
  }

  const gitmodules = fs.readFileSync(path.join(root, ".gitmodules"), "utf8");
  const activeGitlinks = activeComponents
    .filter((entry) => entry.submodule === true)
    .map((entry) => entry.path)
    .filter((entry) => typeof entry === "string");
  for (const [kind, prefix, parked] of [
    ["plugin", "plugins/", parkedPlugins],
    ["app", "apps/", parkedApps],
  ]) {
    const gitlinks = [...gitmodules.matchAll(new RegExp(`^\\s*path\\s*=\\s*(${prefix}[^\\s]+)\\s*$`, "gm"))]
      .map((match) => match[1])
      .sort();
    const active = activeGitlinks.filter((entry) => entry.startsWith(prefix));
    const classified = [...active, ...parked].sort();
    for (const gitlinkPath of gitlinks) {
      if (!classified.includes(gitlinkPath)) issues.push(`${kind} is neither active nor parked in CI inventory: ${gitlinkPath}`);
    }
    for (const classifiedPath of classified) {
      if (!gitlinks.includes(classifiedPath)) issues.push(`classified ${kind} is not a repository gitlink: ${classifiedPath}`);
    }
  }

  const allowedDataGitlinks = ["data/andromeda", "data/darkfactory"];
  const declaredDataGitlinks = [...gitmodules.matchAll(/^\s*path\s*=\s*(data\/[^\s]+)\s*$/gm)]
    .map((match) => match[1])
    .sort();
  const actualDataGitlinks = indexedGitlinks(root).filter((entry) => entry.startsWith("data/"));
  for (const declaredPath of declaredDataGitlinks) {
    if (!allowedDataGitlinks.includes(declaredPath)) issues.push(`data repository declaration is not allowlisted: ${declaredPath}`);
  }
  for (const gitlinkPath of actualDataGitlinks) {
    if (!allowedDataGitlinks.includes(gitlinkPath)) issues.push(`data repository gitlink is not allowlisted: ${gitlinkPath}`);
  }
  for (const allowedPath of allowedDataGitlinks) {
    if (!declaredDataGitlinks.includes(allowedPath)) issues.push(`allowlisted data repository is not declared in .gitmodules: ${allowedPath}`);
    if (!actualDataGitlinks.includes(allowedPath)) issues.push(`allowlisted data repository is not a repository gitlink: ${allowedPath}`);
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
  if (!/^\s+needs:\s+suites\s*$/m.test(workflow)) issues.push("Validate must aggregate every suite matrix leg");
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
