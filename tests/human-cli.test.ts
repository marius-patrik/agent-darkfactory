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
import { runCli } from "../src/cli.js";

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

test("the remaining dependency-owned submodule family fails explicitly instead of falling through as unknown", async () => {
  await assert.rejects(() => runCli(["submodules", "status", "marius-patrik/Andromeda", "--json"]), /submodule convergence engine from #43/);
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
