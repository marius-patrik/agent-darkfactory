import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverBunTests, managerTestTimeoutMs } from "./run-ci-suite.mjs";
import { inventoryIssues, parseIndexedGitlinks } from "./verify-test-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureGitlinkOid = "1111111111111111111111111111111111111111";

function git(target, ...args) {
  return execFileSync("git", ["-C", target, ...args], { encoding: "utf8" });
}

function addIndexEntries(target, input) {
  execFileSync("git", ["-C", target, "update-index", "--info-only", "--index-info"], { input });
}

function fixture() {
  const target = mkdtempSync(path.join(tmpdir(), "andromeda-ci-inventory-"));
  for (const relative of ["ci", "scripts", ".github/workflows", "packages"]) {
    mkdirSync(path.join(target, relative), { recursive: true });
  }
  cpSync(path.join(root, "ci", "test-inventory.json"), path.join(target, "ci", "test-inventory.json"));
  cpSync(path.join(root, ".gitmodules"), path.join(target, ".gitmodules"));
  cpSync(path.join(root, ".github", "workflows", "ci.yml"), path.join(target, ".github", "workflows", "ci.yml"));
  const inventory = JSON.parse(requireText(path.join(target, "ci", "test-inventory.json")));
  for (const entry of inventory.activeComponents) {
    if (!entry.submodule) mkdirSync(path.join(target, entry.path), { recursive: true });
  }
  // Scaffolded components exist as directories carrying only their contract
  // README, so the fail-closed package enumeration must still see them.
  for (const relative of inventory.scaffoldedComponents ?? []) {
    mkdirSync(path.join(target, relative), { recursive: true });
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
    const coreTest = path.join(target, "packages", "migrate", "core", "tests", "new-contract.spec.ts");
    const harnessTest = path.join(target, "packages", "migrate", "harness", "test", "nested", "new-tool.test.js");
    mkdirSync(path.dirname(coreTest), { recursive: true });
    mkdirSync(path.dirname(harnessTest), { recursive: true });
    writeFileSync(coreTest, "fixture\n");
    writeFileSync(harnessTest, "fixture\n");
    assert.ok(discoverBunTests(path.join("packages", "migrate", "core", "tests"), target).includes(path.relative(target, coreTest)));
    assert.ok(discoverBunTests(path.join("packages", "migrate", "harness", "test"), target).includes(path.relative(target, harnessTest)));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("success: serialized manager tests retain a bounded Windows filesystem timeout", () => {
  assert.equal(managerTestTimeoutMs("linux"), 30_000);
  assert.equal(managerTestTimeoutMs("darwin"), 30_000);
  assert.equal(managerTestTimeoutMs("win32"), 90_000);
});

test("edge input: a missing manager-coupled harness test fails the inventory", () => {
  const target = fixture();
  try {
    rmSync(path.join(target, "packages", "migrate", "manager", "test", "session.test.ts"));
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

test("denied failure: a new managed package without an inventory classification cannot pass layout validation", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "packages/unclassified"]\n\tpath = packages/unclassified\n\turl = https://example.test/Unclassified.git\n`,
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /managed package is neither active nor parked in CI inventory: packages\/unclassified/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: Validate cannot omit fresh-clone evidence for the moved public gitlinks", () => {
  const target = fixture();
  try {
    const workflowPath = path.join(target, ".github", "workflows", "ci.yml");
    writeFileSync(
      workflowPath,
      requireText(workflowPath).replace("git submodule update --init --recursive -- agents/darkfactory", "git submodule update --init --recursive -- packages/omitted"),
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /repository contract must fetch full history and initialize every moved public gitlink/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: managed package classifications must be unique and mutually exclusive", () => {
  const target = fixture();
  try {
    const inventoryPath = path.join(target, "ci", "test-inventory.json");
    const inventory = JSON.parse(requireText(inventoryPath));
    inventory.parkedPlugins.push("agents/darkfactory", "agents/lifequest");
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    const issues = inventoryIssues(target).join("\n");
    assert.match(issues, /managed package has conflicting CI classifications \(active, parked plugin\): agents\/darkfactory/);
    assert.match(issues, /managed package is repeated in the parked plugin CI classification: agents\/lifequest/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: an index-only package gitlink cannot evade declaration and classification", () => {
  const target = fixture();
  try {
    addIndexEntries(target, `160000 ${fixtureGitlinkOid} 0\tpackages/index-only\n`);
    const issues = inventoryIssues(target).join("\n");
    assert.match(issues, /managed package gitlink is not declared in \.gitmodules: packages\/index-only/);
    assert.match(issues, /managed package is neither active nor parked in CI inventory: packages\/index-only/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: declarations and index gitlinks outside data and packages cannot pass", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "legacy-plugin"]\n\tpath = plugins/legacy\n\turl = https://example.test/legacy.git\n`,
    );
    addIndexEntries(target, `160000 ${fixtureGitlinkOid} 0\tapps/index-only\n`);
    const issues = inventoryIssues(target).join("\n");
    assert.match(issues, /managed repository declaration is outside data\/, packages\/, or agents\/: plugins\/legacy/);
    assert.match(issues, /managed repository gitlink is outside data\/, packages\/, or agents\/: apps\/index-only/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: a classified managed package declaration without an index gitlink cannot pass", () => {
  const target = fixture();
  try {
    git(target, "update-index", "--force-remove", "agents/darkfactory");
    assert.match(
      inventoryIssues(target).join("\n"),
      /classified managed package is not a repository gitlink: agents\/darkfactory/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: duplicate managed package declarations cannot pass", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "duplicate-darkfactory"]\n\tpath = agents/darkfactory\n\turl = https://example.test/duplicate.git\n`,
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /managed package is declared multiple times: agents\/darkfactory/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: conflicted managed package index entries cannot pass", () => {
  const target = fixture();
  try {
    git(target, "update-index", "--force-remove", "agents/darkfactory");
    addIndexEntries(
      target,
      `160000 ${fixtureGitlinkOid} 1\tagents/darkfactory\n160000 ${fixtureGitlinkOid} 2\tagents/darkfactory\n`,
    );
    const issues = inventoryIssues(target).join("\n");
    assert.match(issues, /managed package has multiple index entries: agents\/darkfactory/);
    assert.match(issues, /managed package has unmerged index entries: agents\/darkfactory/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: managed gitlinks must be lowercase direct package children", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "uppercase"]\n\tpath = packages/Uppercase\n\turl = https://example.test/uppercase.git\n[submodule "nested"]\n\tpath = packages/nested/rogue\n\turl = https://example.test/nested.git\n`,
    );
    addIndexEntries(
      target,
      `160000 ${fixtureGitlinkOid} 0\tpackages/Uppercase\n160000 ${fixtureGitlinkOid} 0\tpackages/nested/rogue\n`,
    );
    const issues = inventoryIssues(target).join("\n");
    assert.match(issues, /managed component path is not a lowercase child of packages\/, packages\/migrate\/, or agents\/: packages\/Uppercase/);
    assert.match(issues, /managed component path is not a lowercase child of packages\/, packages\/migrate\/, or agents\/: packages\/nested\/rogue/);
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

test("denied failure: a newline-bearing data gitlink cannot disappear during index parsing", () => {
  const roguePath = "data/rogue\nname";
  const rawIndex = `160000 ${fixtureGitlinkOid} 0\t${roguePath}\0`;
  assert.deepEqual(parseIndexedGitlinks(rawIndex), [{ path: roguePath, stage: 0 }]);
});

test("denied failure: a quoted data declaration with a trailing comment cannot evade the allowlist", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "rogue"]\n\tpath = "data/rogue name" # parsed by git config\n\turl = https://example.test/rogue.git\n`,
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /data repository declaration is not allowlisted: data\/rogue name/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: duplicate allowlisted data declarations cannot pass", () => {
  const target = fixture();
  try {
    const gitmodulesPath = path.join(target, ".gitmodules");
    writeFileSync(
      gitmodulesPath,
      `${requireText(gitmodulesPath)}[submodule "duplicate-data"]\n\tpath = data/andromeda\n\turl = https://example.test/duplicate.git\n`,
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /allowlisted data repository is declared multiple times: data\/andromeda/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: a rogue nonzero-stage data gitlink cannot evade the allowlist", () => {
  const target = fixture();
  try {
    addIndexEntries(target, `160000 ${fixtureGitlinkOid} 2\tdata/rogue-stage\n`);
    assert.match(
      inventoryIssues(target).join("\n"),
      /data repository gitlink is not allowlisted: data\/rogue-stage/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: duplicate staged entries for an allowlisted data path cannot pass", () => {
  const target = fixture();
  try {
    git(target, "update-index", "--force-remove", "data/andromeda");
    addIndexEntries(
      target,
      `160000 ${fixtureGitlinkOid} 1\tdata/andromeda\n160000 ${fixtureGitlinkOid} 2\tdata/andromeda\n`,
    );
    assert.match(
      inventoryIssues(target).join("\n"),
      /allowlisted data repository has multiple index entries: data\/andromeda/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("denied failure: a lone nonzero-stage allowlisted gitlink cannot pass", () => {
  const target = fixture();
  try {
    git(target, "update-index", "--force-remove", "data/andromeda");
    addIndexEntries(target, `160000 ${fixtureGitlinkOid} 2\tdata/andromeda\n`);
    assert.match(
      inventoryIssues(target).join("\n"),
      /allowlisted data repository has unmerged index entries: data\/andromeda/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
