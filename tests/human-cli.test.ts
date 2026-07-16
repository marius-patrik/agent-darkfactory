import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HUMAN_COMMANDS,
  formatCommandHelp,
  humanCommandId,
  humanJsonResult,
  parseHumanCliArgs
} from "../src/human-cli.js";
import {
  executeSubmoduleEngine,
  parseSubmoduleCliArgs,
  runCli,
  submoduleGithubPermissions,
  submoduleJsonResult
} from "../src/cli.js";

test("human CLI registry covers every owner-approved command family and both executable aliases", async () => {
  const ids = new Set(HUMAN_COMMANDS.map((entry) => entry.id));
  for (const required of [
    "repo-init", "repo-doctor", "repo-sync", "repo-status",
    "issue-draft", "issue-review", "issue-fix", "issue-ready", "issue-ask",
    "plan", "streams", "dashboard", "work", "resume", "verify",
    "pr-review", "pr-fix", "pr-status", "pr-merge",
    "release-status", "release-plan", "release-reconcile", "release-run", "release-verify",
    "submodules-status", "submodules-update", "submodules-verify",
    "baseline-status", "baseline-sync", "baseline-verify",
    "explain", "runs-list", "runs-show", "runs-watch", "runs-retry",
    "receipts-list", "receipts-show", "receipts-verify",
    "lane-pause", "lane-resume", "runners-status", "logs",
    "doctor", "setup", "clean-plan", "clean-apply", "clean-verify"
  ]) assert.ok(ids.has(required), `missing command specification ${required}`);

  const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.bin.df, "./dist/cli.js");
  assert.equal(packageJson.bin.darkfactory, packageJson.bin.df);
});

test("per-command help exposes purpose, defaults, independent model/effort, permissions, trust, examples, and failures", () => {
  const parsed = parseHumanCliArgs(["issue", "draft", "--help"]);
  assert.ok(parsed?.help);
  const help = formatCommandHelp(parsed.spec);
  for (const section of [
    "Usage:", "Defaults:", "Model tier vs effort:", "Permissions:", "Mutations:",
    "Trust boundaries:", "Options:", "Examples:", "Failure and exit semantics:"
  ]) assert.match(help, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(help, /Tier high is fixed by policy/);
  assert.match(help, /--effort/);
});

test("safe defaults, aliases, exact version gates, and unknown options fail closed", () => {
  assert.equal(parseHumanCliArgs(["release"])?.spec.id, "release-status");
  assert.equal(parseHumanCliArgs(["clean"])?.spec.id, "clean-plan");
  assert.equal(parseHumanCliArgs(["why", "issue", "owner/repo#1"])?.spec.id, "explain");
  assert.throws(() => parseHumanCliArgs(["repo", "status", "owner/repo", "--tier", "high"]), /does not accept --tier/);
  assert.throws(() => parseHumanCliArgs(["repo", "status", "owner/repo", "--effort", "high"]), /unknown repo status option/);
  assert.throws(() => parseHumanCliArgs(["issue", "review", "owner/repo#1"]), /requires --version/);
  assert.throws(() => parseHumanCliArgs(["work", "owner/repo#1"]), /requires --version/);
  assert.throws(() => parseHumanCliArgs(["lane", "resume", "owner/repo#1", "--version", "a", "--approve", "b"]), /matching --version and --approve/);
  assert.throws(() => parseHumanCliArgs(["issue", "ready", "owner/repo#1", "--version", "a", "--unknown"]), /unknown issue ready option/);
  assert.throws(() => parseHumanCliArgs(["pr", "status", "owner/repo#1", "--version", "a:b"]), /unknown pr status option/);
  assert.throws(() => parseHumanCliArgs(["runs", "list", "owner/repo", "--approve", "1"]), /unknown runs list option/);
  assert.throws(() => parseHumanCliArgs(["clean", "plan", "owner/repo", "--watch"]), /unknown clean plan option/);
  assert.throws(() => parseHumanCliArgs(["release", "status", "owner/repo", "--watch"]), /unknown release status option/);
});

test("JSON results have one stable versioned envelope", () => {
  assert.deepEqual(humanJsonResult("issue-ready", "blocked", { ready: false }, { code: "not_ready", message: "blocked" }), {
    schemaVersion: 1,
    command: "issue-ready",
    status: "blocked",
    data: { ready: false },
    error: { code: "not_ready", message: "blocked" }
  });
  assert.equal(humanCommandId(["issue", "ready", "owner/repo#1", "--unknown", "--json"]), "issue-ready");
  assert.deepEqual(humanJsonResult("unknown", "error", null, { code: "command_failed", message: "unknown command" }), {
    schemaVersion: 1,
    command: "unknown",
    status: "error",
    data: null,
    error: { code: "command_failed", message: "unknown command" }
  });
});

test("JSON issue drafting never falls through to interactive prompts", async () => {
  const draftPath = path.join(tmpdir(), `darkfactory-missing-${randomUUID()}.json`);
  await assert.rejects(
    () => runCli(["issue", "draft", "marius-patrik/DarkFactory", "--draft", draftPath, "--json"]),
    /requires --input or an existing --draft/
  );
});

test("submodule CLI preserves status/update/verify parity with the shared engine", async () => {
  const status = parseSubmoduleCliArgs(["status", "marius-patrik/DarkFactory", "--watch", "--json"]);
  assert.deepEqual(status, { mode: "status", child: "marius-patrik/DarkFactory", watch: true, json: true });
  assert.ok(Object.values(submoduleGithubPermissions("status")).every((permission) => permission === "read"));
  assert.equal(submoduleGithubPermissions("update").contents, "write");
  assert.equal(submoduleGithubPermissions("verify").pull_requests, "write");

  const calls: Array<{ mode: string; child: string }> = [];
  const results = [
    { schemaVersion: 1, mode: "update", status: "waiting-for-validation", plan: { action: "update" } },
    { schemaVersion: 1, mode: "update", status: "released", plan: { action: "released" } }
  ];
  let waits = 0;
  const updated = await executeSubmoduleEngine(
    parseSubmoduleCliArgs(["update", "marius-patrik/DarkFactory", "--watch"]),
    { async run(input) { calls.push(input); return results.shift()!; } },
    { maxPasses: 3, wait: async () => { waits += 1; } }
  );
  assert.equal(updated.status, "released");
  assert.equal(waits, 1);
  assert.deepEqual(calls, [
    { mode: "update", child: "marius-patrik/DarkFactory" },
    { mode: "update", child: "marius-patrik/DarkFactory" }
  ]);

  const verified = await executeSubmoduleEngine(
    parseSubmoduleCliArgs(["verify", "marius-patrik/DarkFactory"]),
    { async run(input) { calls.push(input); return { schemaVersion: 1, mode: input.mode, status: "current", plan: { action: "current" } }; } }
  );
  assert.equal(verified.mode, "verify");
  assert.equal(calls.at(-1)?.mode, "verify");
  assert.deepEqual(submoduleJsonResult(
    parseSubmoduleCliArgs(["verify", "--json"]),
    { schemaVersion: 1, mode: "verify", status: "blocked" }
  ), {
    schemaVersion: 1,
    command: "submodules-verify",
    status: "blocked",
    data: { schemaVersion: 1, mode: "verify", status: "blocked" },
    error: { code: "submodule_convergence_blocked", message: "Submodule convergence is blocked by current evidence" }
  });
});

test("submodule CLI rejects ambiguous and bypassing mutation requests", () => {
  assert.throws(() => parseSubmoduleCliArgs(["update", "owner/one", "owner/two"]), /at most one/);
  assert.throws(() => parseSubmoduleCliArgs(["verify", "--force"]), /intentionally unavailable/);
  assert.throws(() => parseSubmoduleCliArgs(["status", "not-a-repository"]), /invalid repository/i);
});

test("CLI and Actions invoke the same issue and PR Autoreview engine with exact version admission", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [cli, workflow, runner, drafting] = await Promise.all([
    readFile(path.join(root, "src", "cli.ts"), "utf8"),
    readFile(path.join(root, ".github", "workflows", "darkfactory-autoreview.yml"), "utf8"),
    readFile(path.join(root, ".github", "scripts", "run-darkfactory-autoreview.mjs"), "utf8"),
    readFile(path.join(root, "src", "issue-development.ts"), "utf8")
  ]);
  assert.match(cli, /executeAutoreview\(/);
  assert.match(workflow, /run-darkfactory-autoreview\.mjs/);
  assert.match(workflow, /DF_EXPECTED_ISSUE_VERSION:/);
  assert.match(workflow, /DF_EXPECTED_BASE_SHA:/);
  assert.match(workflow, /target_version:[\s\S]*required: true/);
  assert.match(runner, /expectedVersion: environment\.DF_EXPECTED_ISSUE_VERSION/);
  assert.match(runner, /expectedBaseSha: directBaseSha \|\| versionBaseSha/);
  assert.match(drafting, /modules\.autoreview\.runAutoreview/);
  assert.doesNotMatch(cli, /\b(?:kimi|codex|claude|agy)(?:\.exe)?\b/i);
});
