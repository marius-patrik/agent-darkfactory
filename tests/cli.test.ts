import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  listReceiptFilesFromTree,
  parseCleanCliArgs,
  parseDoctorCliArgs,
  parseReleaseCliArgs,
  parseSetupCliArgs,
  readExactReceiptFile,
  releaseResultIsBlocked,
  validateReceiptDocument,
  type ReceiptFileEvidence
} from "../src/cli.js";
import { HUMAN_COMMANDS, parseHumanCliArgs } from "../src/human-cli.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const CREATED_AT = "2026-07-16T12:34:56.789Z";

function workVerificationReceipt() {
  return {
    kind: "cli-work-verify",
    target_repo: "marius-patrik/DarkFactory",
    created_at: CREATED_AT,
    schemaVersion: 1,
    target: "marius-patrik/DarkFactory#263",
    verified: true,
    issueVersion: "e".repeat(64),
    pull: { number: 300, url: "https://github.com/marius-patrik/DarkFactory/pull/300", mergedAt: "2026-07-16T12:30:00.000Z" },
    predicates: [
      { id: "issue-done", passed: true, evidence: "df:done is present." },
      { id: "merged-worker-pr", passed: true, evidence: "Merged PR #300." },
      { id: "gate-validate", passed: true, evidence: "Validate is green." },
      { id: "gate-darkfactory-autoreview", passed: true, evidence: "DarkFactory Autoreview is green." }
    ]
  };
}

function receiptEvidence(overrides: Partial<ReceiptFileEvidence> = {}): ReceiptFileEvidence {
  return {
    name: "2026-07-16T12-34-56-789Z-cli-work-verify.json",
    path: "runs/marius-patrik/DarkFactory/2026-07-16T12-34-56-789Z-cli-work-verify.json",
    sha: SHA_A,
    ledgerRevision: SHA_B,
    commitSha: SHA_C,
    actor: { login: "darkfactory-agent[bot]", type: "Bot" },
    ...overrides
  };
}

test("doctor CLI defaults to read-only control-repository diagnosis", () => {
  const parsed = parseDoctorCliArgs([]);
  assert.equal(parsed.target, "marius-patrik/DarkFactory");
  assert.equal(parsed.all, false);
  assert.equal(parsed.writeIssues, false);
});

test("doctor CLI parses explicit report and local evidence options", () => {
  const parsed = parseDoctorCliArgs([
    "marius-patrik/Andromeda",
    "--write-issues",
    "--json",
    "--local",
    "C:\\work\\Andromeda",
    "--agents-home",
    "C:\\Users\\patrik\\.agents"
  ]);
  assert.equal(parsed.target, "marius-patrik/Andromeda");
  assert.equal(parsed.writeIssues, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.localPath, "C:\\work\\Andromeda");
});

test("doctor CLI rejects ambiguous, unknown, and repair options", () => {
  assert.throws(() => parseDoctorCliArgs(["--all", "marius-patrik/Andromeda"]), /cannot be combined/);
  assert.throws(() => parseDoctorCliArgs(["--all", "--local", "."]), /cannot inspect/);
  assert.throws(() => parseDoctorCliArgs(["--repair"]), /intentionally unavailable/);
  assert.throws(() => parseDoctorCliArgs(["--unknown"]), /unknown doctor option/);
});

test("setup CLI shares doctor targeting and rejects destructive bypasses", () => {
  const parsed = parseSetupCliArgs([
    "marius-patrik/Andromeda",
    "--watch",
    "--json",
    "--local",
    "C:\\work\\Andromeda",
    "--agents-home",
    "C:\\Users\\patrik\\.agents"
  ]);
  assert.equal(parsed.target, "marius-patrik/Andromeda");
  assert.equal(parsed.watch, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.localPath, "C:\\work\\Andromeda");
  assert.equal(parsed.agentsHome, "C:\\Users\\patrik\\.agents");
  assert.throws(() => parseSetupCliArgs(["--force"]), /intentionally unavailable/);
});

test("setup command registry exposes and the adapter forwards exact local evidence paths", async () => {
  const parsed = parseHumanCliArgs(["setup", "marius-patrik/Andromeda", "--local", "C:\\work\\Andromeda", "--agents-home", "C:\\Users\\patrik\\.agents"]);
  assert.equal(parsed?.options["--local"], "C:\\work\\Andromeda");
  assert.equal(parsed?.options["--agents-home"], "C:\\Users\\patrik\\.agents");
  const source = await readFile(path.resolve(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
  assert.match(source, /command\.options\["--local"\][\s\S]{0,180}\["--local", command\.options\["--local"\]/);
  assert.match(source, /command\.options\["--agents-home"\][\s\S]{0,220}\["--agents-home", command\.options\["--agents-home"\]/);
});

test("clean CLI defaults to plan and requires an explicit durable apply ID", () => {
  const previous = process.env.AGENTS_HOME;
  process.env.AGENTS_HOME = "C:\\Users\\patrik\\.agents";
  try {
    const plan = parseCleanCliArgs(["marius-patrik/Andromeda", "--local", "C:\\work\\Andromeda"]);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.target, "marius-patrik/Andromeda");
    assert.throws(() => parseCleanCliArgs(["apply"]), /requires a durable plan ID/);
    assert.throws(() => parseCleanCliArgs(["apply", "clean-123", "--force"]), /intentionally unavailable/);
  } finally {
    if (previous === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previous;
  }
});

test("release CLI defaults to status and keeps watch separate from authorization", () => {
  const status = parseReleaseCliArgs([]);
  assert.equal(status.mode, "status");
  assert.equal(status.target, "marius-patrik/DarkFactory");

  const run = parseReleaseCliArgs(["run", "marius-patrik/Andromeda", "--watch", "--json"]);
  assert.equal(run.mode, "run");
  assert.equal(run.watch, true);
  assert.equal(run.target, "marius-patrik/Andromeda");
  assert.throws(() => parseReleaseCliArgs(["verify", "--watch"]), /only with release run/);
  assert.throws(() => parseReleaseCliArgs(["run", "--bypass"]), /intentionally unavailable/);
});

test("blocked release outcomes cannot use the successful command contract", () => {
  for (const status of ["blocked", "failed", "owner-required"]) {
    assert.equal(releaseResultIsBlocked({ status }), true, status);
  }
  for (const status of ["observed", "waiting-for-green", "automerge-armed", "verified", "skipped"]) {
    assert.equal(releaseResultIsBlocked({ status }), false, status);
  }
});

test("receipt verification accepts an exact completion contract and exposes every promised proof facet", () => {
  const verified = validateReceiptDocument(workVerificationReceipt(), "marius-patrik/DarkFactory", receiptEvidence());
  assert.equal(verified.schemaVersion, 1);
  assert.equal(verified.kind, "cli-work-verify");
  assert.deepEqual(verified.immutableRefs, ["e".repeat(64)]);
  assert.equal(verified.actor.login, "darkfactory-agent[bot]");
  assert.equal(verified.gates.length, 4);
  assert.equal(verified.outcome, "verified");
  assert.deepEqual(verified.handoff, {
    pullRequest: 300,
    url: "https://github.com/marius-patrik/DarkFactory/pull/300",
    mergedAt: "2026-07-16T12:30:00.000Z"
  });
});

test("receipt verification rejects forged actor, replayed timestamp, incomplete gates, and unknown kinds", () => {
  assert.throws(
    () => validateReceiptDocument(workVerificationReceipt(), "marius-patrik/DarkFactory", receiptEvidence({ actor: { login: "github-actions[bot]", type: "Bot" } })),
    /exact trusted DarkFactory App identity/
  );
  const replayedName = "2026-07-15T12-34-56-789Z-cli-work-verify.json";
  assert.throws(
    () => validateReceiptDocument(workVerificationReceipt(), "marius-patrik/DarkFactory", receiptEvidence({ name: replayedName, path: `runs/marius-patrik/DarkFactory/${replayedName}` })),
    /stale or replayed/
  );
  const incomplete = workVerificationReceipt();
  incomplete.predicates = incomplete.predicates.filter((predicate) => predicate.id !== "gate-darkfactory-autoreview");
  assert.throws(
    () => validateReceiptDocument(incomplete, "marius-patrik/DarkFactory", receiptEvidence()),
    /missing predicate gate-darkfactory-autoreview/
  );
  const unknown = { kind: "invented", target_repo: "marius-patrik/DarkFactory", created_at: CREATED_AT };
  const unknownName = "2026-07-16T12-34-56-789Z-invented.json";
  assert.throws(
    () => validateReceiptDocument(unknown, "marius-patrik/DarkFactory", receiptEvidence({ name: unknownName, path: `runs/marius-patrik/DarkFactory/${unknownName}` })),
    /has no explicit verifier/
  );
});

test("release receipt validator binds converged refs, App-bound gates, intent, outcome, and publication handoff", () => {
  const release = {
    kind: "df-release",
    target_repo: "marius-patrik/DarkFactory",
    created_at: CREATED_AT,
    status: "verified",
    plan_id: "release-0123456789abcdefabcd",
    repository: "marius-patrik/DarkFactory",
    main_sha: SHA_A,
    dev_sha: SHA_A,
    main_tree_sha: SHA_B,
    dev_tree_sha: SHA_B,
    policy_mode: "branch-only",
    release: {
      green: true,
      pull_request: "https://github.com/marius-patrik/DarkFactory/pull/300",
      head_sha: SHA_A,
      tree_sha: SHA_B,
      checks: {
        green: true,
        checks: [
          { name: "Validate", state: "green", actualAppId: 15368 },
          { name: "DarkFactory Autoreview", state: "green", actualAppId: 15368 }
        ]
      }
    },
    publication: { green: true, mode: "branch-only" }
  };
  const name = "2026-07-16T12-34-56-789Z-df-release.json";
  const verified = validateReceiptDocument(release, "marius-patrik/DarkFactory", receiptEvidence({ name, path: `runs/marius-patrik/DarkFactory/${name}` }));
  assert.equal(verified.kind, "df-release");
  assert.equal(verified.gates.length, 2);
  assert.equal(verified.outcome, "verified");
  const incomplete = structuredClone(release);
  incomplete.release.checks.checks.pop();
  assert.throws(
    () => validateReceiptDocument(incomplete, "marius-patrik/DarkFactory", receiptEvidence({ name, path: `runs/marius-patrik/DarkFactory/${name}` })),
    /missing required gate DarkFactory Autoreview/
  );
});

test("receipt list traverses an exact Git tree and returns more than the Contents API 1000-entry ceiling", async () => {
  const treeBySha = new Map<string, unknown>([
    [SHA_A, { truncated: false, tree: [{ path: "runs", type: "tree", sha: SHA_B }] }],
    [SHA_B, { truncated: false, tree: [{ path: "marius-patrik", type: "tree", sha: SHA_C }] }],
    [SHA_C, { truncated: false, tree: [{ path: "DarkFactory", type: "tree", sha: SHA_D }] }],
    [SHA_D, {
      truncated: false,
      tree: Array.from({ length: 1001 }, (_, index) => ({
        path: `${String(index).padStart(4, "0")}-df-release.json`,
        type: "blob",
        sha: index.toString(16).padStart(40, "0"),
        url: `https://api.github.test/blob/${index}`
      }))
    }]
  ]);
  const files = await listReceiptFilesFromTree({
    async request(_method, requestPath) {
      const sha = requestPath.split("/").at(-1) || "";
      const value = treeBySha.get(sha);
      if (!value) throw new Error(`unexpected tree ${sha}`);
      return value;
    }
  }, "marius-patrik/DarkFactory", { headSha: "f".repeat(40), rootTreeSha: SHA_A });
  assert.equal(files.length, 1001);
  assert.equal(files[1000].name, "1000-df-release.json");
});

test("exact-name receipt lookup fetches the immutable path directly without a bounded directory listing", async () => {
  const requests: string[] = [];
  const name = "2026-07-16T12-34-56-789Z-cli-work-verify.json";
  const filePath = `runs/marius-patrik/DarkFactory/${name}`;
  const file = await readExactReceiptFile({
    async request(_method, requestPath) {
      requests.push(requestPath);
      return {
        type: "file",
        name,
        path: filePath,
        sha: SHA_A,
        encoding: "base64",
        content: Buffer.from(JSON.stringify(workVerificationReceipt())).toString("base64")
      };
    }
  }, "marius-patrik/DarkFactory", name, { headSha: SHA_B, rootTreeSha: SHA_C });
  assert.equal(file.name, name);
  assert.deepEqual(requests, [`/repos/marius-patrik/darkfactory-data/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${SHA_B}`]);
  assert.equal(requests.some((request) => request.includes("/git/trees/")), false);
});

test("every JSON verb adapter uses the universal command envelope and exposes blocked convergence", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
  assert.doesNotMatch(source, /if \(options\.json\) console\.log\(JSON\.stringify\((?:reports|result|\{ \.\.\.receipt)/);
  assert.match(source, /humanJsonResult\(commandId, "ok", reports\)/);
  assert.match(source, /setup_not_converged/);
  assert.match(source, /release_convergence_blocked/);
  assert.match(source, /clean_verification_blocked/);
  assert.match(source, /clean_convergence_blocked/);
  for (const id of ["doctor", "setup", "clean-plan", "clean-apply", "clean-verify", "release-status", "release-plan", "release-reconcile", "release-run", "release-verify"]) {
    const command = HUMAN_COMMANDS.find((entry) => entry.id === id);
    assert.equal(command?.options.some((option) => option.name === "--json"), true, id);
  }
});
