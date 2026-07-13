import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverBunTests } from "./run-ci-suite.mjs";
import { inventoryIssues } from "./verify-test-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureGitlinkOid = "1111111111111111111111111111111111111111";

function git(target, ...args) {
  return execFileSync("git", ["-C", target, ...args], { encoding: "utf8" });
}

function fixture() {
  const target = mkdtempSync(path.join(tmpdir(), "andromeda-ci-inventory-"));
  for (const relative of ["ci", "scripts", ".github/workflows", "apps", "packages", "plugins"]) {
    mkdirSync(path.join(target, relative), { recursive: true });
  }
  cpSync(path.join(root, "ci", "test-inventory.json"), path.join(target, "ci", "test-inventory.json"));
  cpSync(path.join(root, ".gitmodules"), path.join(target, ".gitmodules"));
  cpSync(path.join(root, ".github", "workflows", "ci.yml"), path.join(target, ".github", "workflows", "ci.yml"));
  const inventory = JSON.parse(requireText(path.join(target, "ci", "test-inventory.json")));
  for (const entry of inventory.activeComponents) {
    if (!entry.submodule) mkdirSync(path.join(target, entry.path), { recursive: true });
  }
  for (const entry of [...inventory.activeComponents, ...inventory.realBehaviorLegs, ...inventory.productSmokes, ...inventory.supportingSuites]) {
    for (const relative of entry.requiredPaths ?? []) {
      const destination = path.join(target, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, "fixture\n");
    }
  }
  git(target, "init", "--quiet");
  for (const match of requireText(path.join(target, ".gitmodules")).matchAll(/^\s*path\s*=\s*([^\s]+)\s*$/gm)) {
    git(target, "update-index", "--add", "--info-only", "--cacheinfo", `160000,${fixtureGitlinkOid},${match[1]}`);
  }
  return target;
}

function requireText(file) {
  return readFileSync(file, "utf8");
}

test("success: the checked-in component inventory and workflow are complete", () => {
  assert.deepEqual(inventoryIssues(root), []);
});

test("success: new core and harness Bun tests join their suites automatically", () => {
  const target = fixture();
  try {
    const coreTest = path.join(target, "packages", "core", "tests", "new-contract.spec.ts");
    const harnessTest = path.join(target, "packages", "harness", "test", "nested", "new-tool.test.js");
    mkdirSync(path.dirname(coreTest), { recursive: true });
    mkdirSync(path.dirname(harnessTest), { recursive: true });
    writeFileSync(coreTest, "fixture\n");
    writeFileSync(harnessTest, "fixture\n");
    assert.ok(discoverBunTests(path.join("packages", "core", "tests"), target).includes(path.relative(target, coreTest)));
    assert.ok(discoverBunTests(path.join("packages", "harness", "test"), target).includes(path.relative(target, harnessTest)));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("edge input: a missing manager-coupled harness test fails the inventory", () => {
  const target = fixture();
  try {
    rmSync(path.join(target, "packages", "manager", "test", "session.test.ts"));
    assert.match(inventoryIssues(target).join("\n"), /harness is missing required suite path/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: a new package without a suite cannot pass layout validation", () => {
  const target = fixture();
  try {
    mkdirSync(path.join(target, "packages", "unwired"));
    assert.match(inventoryIssues(target).join("\n"), /package has no fail-closed CI inventory entry: packages\/unwired/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: a new app without an inventory classification cannot pass layout validation", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "Unclassified"]\n\tpath = apps/Unclassified\n\turl = https://example.test/Unclassified.git\n`,
    );
    assert.match(inventoryIssues(target).join("\n"), /app is neither active nor parked in CI inventory: apps\/Unclassified/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("edge input: a missing allowlisted data repository cannot pass layout validation", () => {
  const target = fixture();
  try {
    git(target, "update-index", "--force-remove", "data/darkfactory");
    assert.match(
      inventoryIssues(target).join("\n"),
      /allowlisted data repository is not a repository gitlink: data\/darkfactory/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: an unapproved data repository cannot pass layout validation", () => {
  const target = fixture();
  try {
    git(
      target,
      "update-index",
      "--add",
      "--info-only",
      "--cacheinfo",
      `160000,${fixtureGitlinkOid},data/Unclassified`,
    );
    assert.match(inventoryIssues(target).join("\n"), /data repository gitlink is not allowlisted: data\/Unclassified/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
