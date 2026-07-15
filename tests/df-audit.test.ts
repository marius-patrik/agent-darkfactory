// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const doctor: any = await import("../.github/scripts/df-audit.mjs?unit=repository-doctor-test");

const repo = { owner: "marius-patrik", repo: "DarkFactory" };
const LABEL_POLICY = JSON.stringify({
  schemaVersion: 1,
  labels: doctor.DOCTOR_REPORT_LABEL_NAMES.map((name: string) => ({ name, color: "0E8A16", description: `label ${name}` }))
});

function content(text: string) {
  return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") };
}

function notFound(message = "not found") {
  return Object.assign(new Error(message), { status: 404 });
}

function mockGh(handler: (method: string, requestPath: string, body?: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    gh: {
      async request(method: string, requestPath: string, body?: unknown) {
        calls.push({ method, path: requestPath, body });
        return await handler(method, requestPath, body);
      }
    }
  };
}

function protectedBranch() {
  return {
    required_status_checks: { strict: true, checks: [{ context: "Validate", app_id: 15368 }, { context: "Codex Review", app_id: 15368 }] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
}

test("doctor modes are explicit and repair is fail-closed", () => {
  assert.equal(doctor.parseDoctorMode("diagnose"), "diagnose");
  assert.equal(doctor.parseDoctorMode("report"), "report");
  assert.throws(() => doctor.parseDoctorMode("repair"), /repair mode is not implemented/i);
  assert.throws(() => doctor.parseDoctorMode("surprise"), /Unknown repository-doctor mode/);
});

test("report mode requires a distinct ledger authority and diagnose needs none", () => {
  const target = { request() {} };
  const ledger = { request() {} };
  assert.doesNotThrow(() => doctor.assertDoctorReportAuthorities("diagnose", target, undefined));
  assert.throws(() => doctor.assertDoctorReportAuthorities("report", target, undefined), /never a ledger fallback/);
  assert.throws(() => doctor.assertDoctorReportAuthorities("report", target, target), /must be distinct/);
  assert.doesNotThrow(() => doctor.assertDoctorReportAuthorities("report", target, ledger));
});

test("report label preflight is read-only and fails visibly when taxonomy is missing", async () => {
  const { gh, calls } = mockGh((method, requestPath) => {
    assert.equal(method, "GET");
    if (requestPath.includes("/labels?") && requestPath.endsWith("page=1")) {
      return doctor.DOCTOR_REPORT_LABEL_NAMES.map((name) => ({ name }));
    }
    throw new Error(`unexpected ${requestPath}`);
  });
  await doctor.assertDoctorReportLabels(gh, repo);
  assert.equal(calls.some((call) => /\/labels(?:[/?]|$)/.test(call.path) && call.method !== "GET"), false);

  const { gh: missingGh } = mockGh(() => [{ name: "P0" }]);
  await assert.rejects(() => doctor.assertDoctorReportLabels(missingGh, repo), /required labels are missing/);
});

test("report mode writes ledger-only skipped evidence for canonical parked and archived repositories", async () => {
  for (const variant of ["parked", "archived"] as const) {
    const target = variant === "parked"
      ? { owner: "marius-patrik", repo: "SkyAgent" }
      : { owner: "marius-patrik", repo: "ArchivedProduct" };
    const { gh: targetGh, calls: targetCalls } = mockGh((_method, requestPath) => {
      if (variant === "archived" && requestPath === "/repos/marius-patrik/ArchivedProduct") {
        return { default_branch: "main", archived: true, disabled: false };
      }
      throw new Error(`skipped target should not be inspected or mutated: ${requestPath}`);
    });
    const { gh: ledgerGh, calls: ledgerCalls } = mockGh((method) => {
      if (method === "GET") throw notFound();
      if (method === "PUT") return {};
      throw new Error(`unexpected ledger method ${method}`);
    });

    const reports = await doctor.runRepositoryDoctor(targetGh, {
      mode: "report",
      trigger: "test",
      controlRepo: repo,
      target,
      ledgerGithub: ledgerGh,
      registry: { schemaVersion: 1, repositories: { "marius-patrik/ArchivedProduct": { state: "active" } } }
    });

    assert.equal(reports[0].skipped, true);
    assert.equal(reports[0].read_only, true);
    assert.equal(reports[0].actions.at(-1).action, "write-doctor-ledger");
    assert.equal(targetCalls.some((call) => call.method !== "GET" || call.path.includes("/labels") || call.path.includes("/issues")), false);
    assert.equal(targetCalls.length, variant === "parked" ? 0 : 1);
    const ledgerWrite = ledgerCalls.find((call) => call.method === "PUT");
    assert.ok(ledgerWrite);
    const ledger = JSON.parse(Buffer.from((ledgerWrite.body as { content: string }).content, "base64").toString("utf8"));
    assert.equal(ledger.phase, "completion");
    assert.equal(ledger.mode, "report");
    assert.match(ledger.observations[0], variant === "parked" ? /parked/ : /read-only/);
    assert.deepEqual(ledger.actions, []);
  }
});

test("stable findings deduplicate evidence and sort by id", () => {
  const findings = doctor.dedupeFindings([
    doctor.doctorFinding("z-last", "test", "last"),
    doctor.doctorFinding("a-first", "test", "first", { evidence: [{ label: "one", url: "https://example.test/1" }] }),
    doctor.doctorFinding("a-first", "test", "duplicate", { evidence: [{ label: "one", url: "https://example.test/1" }] })
  ]);
  assert.deepEqual(findings.map((finding) => finding.id), ["a-first", "z-last"]);
  assert.equal(findings[0].evidence.length, 1);
});

test("doctor findings classify deterministic repair authority", () => {
  assert.equal(doctor.DOCTOR_SCHEMA_VERSION, 2);
  assert.deepEqual(doctor.DOCTOR_REPAIR_CLASSES, ["auto", "pr", "owner", "blocked"]);

  const auto = doctor.doctorFinding("protection-dev-missing", "branch protection", "Protection is missing.");
  const reviewed = doctor.doctorFinding("managed-file-drift-ci", "managed file drift", "Managed CI differs.");
  const owner = doctor.doctorFinding("pr-12-stale", "pull request health", "PR #12 is stale.");
  const blocked = doctor.doctorFinding(
    "protection-main-unobservable",
    "branch protection",
    "Protection is inaccessible and unobservable."
  );

  assert.equal(auto.repair_class, "auto");
  assert.equal(reviewed.repair_class, "pr");
  assert.equal(owner.repair_class, "owner");
  assert.equal(blocked.repair_class, "blocked");
  assert.equal(
    doctor.doctorFinding("explicit", "test", "explicit", { repairClass: "pr" }).repair_class,
    "pr"
  );
  assert.throws(
    () => doctor.doctorFinding("invalid", "test", "invalid", { repairClass: "force" }),
    /Unknown repository-doctor repair class/
  );
});

test("parseGitmodules preserves exact names, paths, urls, and branches", () => {
  assert.deepEqual(doctor.parseGitmodules(`[submodule "DarkFactory"]\n path = plugins/DarkFactory\n url = https://github.com/marius-patrik/DarkFactory.git\n branch = main\n`), [
    { name: "DarkFactory", path: "plugins/DarkFactory", url: "https://github.com/marius-patrik/DarkFactory.git", branch: "main" }
  ]);
  assert.deepEqual(doctor.parseGitmodules(""), []);
});

test("branch policy accepts protected identical main/dev and exempts active PR heads", async () => {
  const branches = [
    { name: "main", commit: { sha: "a" } },
    { name: "dev", commit: { sha: "a" } },
    { name: "feature/live", commit: { sha: "b" } }
  ];
  const pull = {
    number: 10,
    head: { ref: "feature/live", sha: "b", repo: { full_name: "marius-patrik/DarkFactory" } },
    base: { ref: "dev" }
  };
  const { gh } = mockGh((method, requestPath) => {
    if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
    if (requestPath.endsWith("/branches/main/protection") || requestPath.endsWith("/branches/dev/protection")) return protectedBranch();
    if (requestPath.endsWith("/pulls/10")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://github.com/marius-patrik/DarkFactory/pull/10" };
    if (requestPath.includes("/commits/b/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/commits/b/status")) return { statuses: [] };
    throw new Error(`unexpected ${method} ${requestPath}`);
  });
  const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
    branches,
    branchNames: new Set(branches.map((branch) => branch.name)),
    pulls: [pull],
    isData: false,
    now: "2026-07-13T01:00:00Z"
  });
  assert.deepEqual(result.findings, []);
});

test("an open PR exempts only the exact same-repository branch head SHA", async () => {
  const branches = [
    { name: "main", commit: { sha: "a" } },
    { name: "dev", commit: { sha: "a" } },
    { name: "feature/moved", commit: { sha: "new-head" } }
  ];
  const pull = {
    number: 11,
    head: { ref: "feature/moved", sha: "stale-pr-head", repo: { full_name: "marius-patrik/DarkFactory" } },
    base: { ref: "dev" }
  };
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.endsWith("/pulls/11")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://example.test/11" };
    if (requestPath.includes("/commits/stale-pr-head/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/commits/stale-pr-head/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
    branches, branchNames: new Set(branches.map((branch) => branch.name)), pulls: [pull], isData: false, now: "2026-07-13T01:00:00Z"
  });
  assert.ok(result.findings.some((finding) => finding.id === "extra-branch-feature-moved"));
});

test("release PRs satisfy the lane only when their same-repository head contains current dev", async () => {
  for (const [relation, eligible] of [["behind", false], ["ahead", true]] as const) {
    const branches = [
      { name: "main", commit: { sha: "main-sha" } },
      { name: "dev", commit: { sha: "dev-sha" } },
      { name: "release/test", commit: { sha: "release-sha" } }
    ];
    const pull = {
      number: 20,
      head: { ref: "release/test", sha: "release-sha", repo: { full_name: "marius-patrik/DarkFactory" } },
      base: { ref: "main" }
    };
    const { gh } = mockGh((_method, requestPath) => {
      if (requestPath.endsWith("/compare/main...dev")) return { status: "ahead", ahead_by: 1, behind_by: 0 };
      if (requestPath.endsWith("/compare/dev...release-sha")) return { status: relation, ahead_by: relation === "ahead" ? 1 : 0, behind_by: relation === "behind" ? 1 : 0 };
      if (requestPath.includes("/protection")) return protectedBranch();
      if (requestPath.endsWith("/pulls/20")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://example.test/20" };
      if (requestPath.includes("/commits/release-sha/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success" }] };
      if (requestPath.includes("/commits/release-sha/status")) return { statuses: [] };
      throw new Error(`unexpected ${requestPath}`);
    });
    const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
      branches, branchNames: new Set(branches.map((branch) => branch.name)), pulls: [pull], isData: false, now: "2026-07-13T01:00:00Z"
    });
    assert.equal(result.findings.some((finding) => finding.id === "release-pr-20-not-current-dev-derived"), !eligible);
    assert.equal(result.findings.some((finding) => finding.id === "release-pr-missing"), !eligible);
  }
});

test("release PR lineage fails closed when GitHub omits comparison counts", async () => {
  const branches = [
    { name: "main", commit: { sha: "main-sha" } },
    { name: "dev", commit: { sha: "dev-sha" } },
    { name: "release/test", commit: { sha: "release-sha" } }
  ];
  const pull = {
    number: 21,
    head: { ref: "release/test", sha: "release-sha", repo: { full_name: "marius-patrik/DarkFactory" } },
    base: { ref: "main" }
  };
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.endsWith("/compare/main...dev")) return { status: "ahead", ahead_by: 1, behind_by: 0 };
    if (requestPath.endsWith("/compare/dev...release-sha")) return { status: "ahead" };
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.endsWith("/pulls/21")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://example.test/21" };
    if (requestPath.includes("/commits/release-sha/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/commits/release-sha/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });

  const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
    branches, branchNames: new Set(branches.map((branch) => branch.name)), pulls: [pull], isData: false, now: "2026-07-13T01:00:00Z"
  });
  const ids = new Set(result.findings.map((finding) => finding.id));
  assert.ok(ids.has("release-pr-21-dev-lineage-malformed"));
  assert.ok(ids.has("release-pr-missing"));
  assert.equal(ids.has("release-pr-21-not-current-dev-derived"), false);
});

test("post-branch health is bound to current head runs and checks and fails closed on pending or inaccessible evidence", async () => {
  const now = "2026-07-13T04:00:00Z";
  const { gh: redGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [
      { name: "Validate", head_sha: "old-head", status: "completed", conclusion: "success" },
      { name: "Validate", head_sha: "current-head", status: "completed", conclusion: "failure", html_url: "https://example.test/run" }
    ] };
    if (requestPath.includes("/commits/current-head/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "failure", app: { id: 15368 } }, { name: "Codex Review", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/commits/current-head/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const red = await doctor.auditHealth(repo, "main", "current-head", redGh, { now });
  const redIds = new Set(red.map((finding) => finding.id));
  assert.ok(redIds.has("workflow-main-validate-red"));
  assert.ok(redIds.has("workflow-main-head-checks-red"));

  const { gh: pendingGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [{ name: "Validate", head_sha: "current-head", status: "in_progress", conclusion: null, run_started_at: "2026-07-13T00:00:00Z" }] };
    if (requestPath.includes("/check-runs")) return { check_runs: [{ name: "Validate", status: "in_progress", conclusion: null, started_at: "2026-07-13T00:00:00Z", app: { id: 15368 } }, { name: "Codex Review", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const pending = await doctor.auditHealth(repo, "main", "current-head", pendingGh, { now });
  const pendingIds = new Set(pending.map((finding) => finding.id));
  assert.ok(pendingIds.has("workflow-main-validate-stuck"));
  assert.ok(pendingIds.has("workflow-main-head-checks-stuck"));

  const { gh: missingGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [{ name: "Validate", head_sha: "current-head", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const missing = await doctor.auditHealth(repo, "main", "current-head", missingGh, { now });
  assert.equal(missing.some((finding) => finding.id === "workflow-main-head-required-checks-missing"), false);

  const { gh: inaccessibleGh } = mockGh(() => { throw Object.assign(new Error("forbidden"), { status: 403 }); });
  const inaccessible = await doctor.auditHealth(repo, "dev", "current-head", inaccessibleGh, { now });
  const inaccessibleIds = new Set(inaccessible.map((finding) => finding.id));
  assert.ok(inaccessibleIds.has("workflow-dev-runs-unobservable"));
  assert.ok(inaccessibleIds.has("workflow-dev-head-checks-unobservable"));
});

test("base-branch health still requires branch CI while leaving PR-only review gates on PR heads", async () => {
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [{ name: "Validate", head_sha: "current-head", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/check-runs")) return { check_runs: [{ name: "Codex Review", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });

  const findings = await doctor.auditHealth(repo, "dev", "current-head", gh);
  assert.ok(findings.some((finding) => finding.id === "workflow-dev-head-required-checks-missing" && /Validate@app:15368/.test(finding.message)));
  assert.equal(findings.some((finding) => /Codex Review@app:15368/.test(finding.message)), false);
});

test("auto-merge observation uses REST, falls back to GraphQL, and fails closed when both are unobservable", async () => {
  assert.deepEqual(await doctor.observeAutoMerge({}, repo, true), { enabled: true, source: "rest" });
  assert.deepEqual(await doctor.observeAutoMerge({
    async graphql() { return { repository: { autoMergeAllowed: false } }; }
  }, repo, undefined), { enabled: false, source: "graphql" });
  assert.deepEqual(await doctor.observeAutoMerge({
    async graphql() { throw Object.assign(new Error("forbidden"), { status: 403 }); }
  }, repo, undefined), { enabled: null, source: "graphql-inaccessible" });
});

test("branch policy classifies behind, diverged, missing, and main-only data repositories", async () => {
  for (const status of ["behind", "diverged"]) {
    const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "b" } }];
    const { gh } = mockGh((_method, requestPath) => {
      if (requestPath.endsWith("/compare/main...dev")) return { status, ahead_by: 1, behind_by: 1 };
      if (requestPath.includes("/protection")) return protectedBranch();
      throw new Error(`unexpected ${requestPath}`);
    });
    const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
      branches, branchNames: new Set(["main", "dev"]), pulls: [], isData: false
    });
    assert.ok(result.findings.some((finding) => finding.id === (status === "behind" ? "dev-behind-main" : "main-dev-diverged")));
  }

  const { gh: missingGh } = mockGh((_method, requestPath) => requestPath.includes("/protection") ? protectedBranch() : (() => { throw new Error(`unexpected ${requestPath}`); })());
  const missing = await doctor.auditBranchAndReleaseState(missingGh, repo, { default_branch: "main", allow_auto_merge: true }, {
    branches: [{ name: "main", commit: { sha: "a" } }], branchNames: new Set(["main"]), pulls: [], isData: false
  });
  assert.ok(missing.findings.some((finding) => finding.id === "dev-branch-missing"));

  const dataRepo = { owner: "marius-patrik", repo: "Andromeda-data" };
  const { gh: dataGh } = mockGh((_method, requestPath) => requestPath.includes("/protection") ? (() => { throw notFound(); })() : (() => { throw new Error(`unexpected ${requestPath}`); })());
  const data = await doctor.auditBranchAndReleaseState(dataGh, dataRepo, { default_branch: "main", allow_auto_merge: false }, {
    branches: [{ name: "main", commit: { sha: "a" } }], branchNames: new Set(["main"]), pulls: [], isData: true
  });
  assert.equal(data.findings.some((finding) => /dev|automerge/.test(finding.id)), false);
});

test("malformed branch comparisons fail closed instead of appearing converged", async () => {
  for (const comparison of [
    { status: "mystery", ahead_by: 0, behind_by: 0 },
    { status: "identical", ahead_by: "0", behind_by: 0 },
    null
  ]) {
    const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "b" } }];
    const { gh } = mockGh((_method, requestPath) => {
      if (requestPath.endsWith("/compare/main...dev")) return comparison;
      if (requestPath.includes("/protection")) return protectedBranch();
      throw new Error(`unexpected ${requestPath}`);
    });
    const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
      branches, branchNames: new Set(["main", "dev"]), pulls: [], isData: false
    });
    assert.ok(result.findings.some((finding) => finding.id === "main-dev-comparison-malformed"));
    assert.equal(result.observations.some((observation) => observation.startsWith("main...dev is")), false);
  }
});

test("branch protection reports each missing or unsafe gate", async () => {
  const { gh } = mockGh(() => ({ required_status_checks: { strict: true, contexts: [] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } }));
  const findings = await doctor.auditBranchProtection(gh, repo, "main", { required: true });
  assert.deepEqual(new Set(findings.map((finding) => finding.id)), new Set([
    "protection-main-validate-missing",
    "protection-main-review-missing",
    "protection-main-force-push",
    "protection-main-deletion"
  ]));
});

test("branch protection requires exact app-bound gates, strict updates, and admin enforcement", async () => {
  const { gh } = mockGh(() => ({
    required_status_checks: { strict: false, checks: [{ context: "CI", app_id: 1 }, { context: "Autoreview lint", app_id: 1 }] },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  }));
  const findings = await doctor.auditBranchProtection(gh, repo, "main", { required: true });
  const ids = new Set(findings.map((finding) => finding.id));
  assert.ok(ids.has("protection-main-validate-missing"));
  assert.ok(ids.has("protection-main-review-missing"));
  assert.ok(ids.has("protection-main-strict-missing"));
  assert.ok(ids.has("protection-main-admin-bypass"));
});

test("branch protection fails closed on unbound and malformed required-check payloads", async () => {
  const { gh: unboundGh } = mockGh(() => ({
    required_status_checks: { strict: true, contexts: ["Validate", "Codex Review"] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  }));
  const unbound = await doctor.auditBranchProtection(unboundGh, repo, "dev", { required: true });
  assert.ok(unbound.some((finding) => finding.id === "protection-dev-validate-app-unbound"));
  assert.ok(unbound.some((finding) => finding.id === "protection-dev-codex-review-app-unbound"));

  const { gh: wrongAppGh } = mockGh(() => ({
    required_status_checks: { strict: true, checks: [{ context: "Validate", app_id: 99999 }, { context: "DarkFactory Autoreview", app_id: 99999 }] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  }));
  const observations: string[] = [];
  const wrongApp = await doctor.auditBranchProtection(wrongAppGh, repo, "dev", { required: true, observations });
  assert.ok(wrongApp.some((finding) => finding.id === "protection-dev-validate-app-mismatch" && /99999.*15368/.test(finding.message)));
  assert.ok(wrongApp.some((finding) => finding.id === "protection-dev-darkfactory-autoreview-app-mismatch"));
  assert.match(observations[0], /Validate@app:99999.*DarkFactory Autoreview@app:99999/);

  const { gh: malformedGh } = mockGh(() => ({ required_status_checks: { strict: true, checks: "invalid" } }));
  const malformed = await doctor.auditBranchProtection(malformedGh, repo, "dev", { required: true });
  const ids = new Set(malformed.map((finding) => finding.id));
  assert.ok(ids.has("protection-dev-required-checks-malformed"));
  assert.ok(ids.has("protection-dev-admin-bypass-unobservable"));
  assert.ok(ids.has("protection-dev-force-push-unobservable"));
  assert.ok(ids.has("protection-dev-deletion-unobservable"));
});

test("branch protection distinguishes inaccessible 403 state from absent 404 state", async () => {
  for (const [status, expected] of [[403, "protection-dev-unobservable"], [404, "protection-dev-missing"]]) {
    const { gh } = mockGh(() => { throw Object.assign(new Error(`HTTP ${status}`), { status }); });
    const findings = await doctor.auditBranchProtection(gh, repo, "dev", { required: true });
    assert.equal(findings[0].id, expected);
    if (status === 403) assert.match(findings[0].message, /unknown, not absent/);
  }
});

test("main-only data repositories do not inherit product gate requirements", async () => {
  const { gh } = mockGh(() => ({
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  }));
  const findings = await doctor.auditBranchProtection(gh, { owner: "marius-patrik", repo: "Andromeda-data" }, "main", {
    protectionRequired: true,
    gatesRequired: false
  });
  assert.deepEqual(findings, []);
});

test("main-only data repositories require observable main protection", async () => {
  const dataRepo = { owner: "marius-patrik", repo: "Andromeda-data" };
  const branches = [{ name: "main", commit: { sha: "a" } }];
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) throw notFound();
    throw new Error(`unexpected ${requestPath}`);
  });
  const result = await doctor.auditBranchAndReleaseState(gh, dataRepo, { default_branch: "main", allow_auto_merge: false }, {
    branches, branchNames: new Set(["main"]), pulls: [], isData: true
  });
  assert.ok(result.findings.some((finding) => finding.id === "protection-main-missing"));
  assert.equal(result.findings.some((finding) => /validate|review|strict/.test(finding.id)), false);
});

test("main-only data repositories still fail closed on admin bypass and inaccessible protection", async () => {
  const dataRepo = { owner: "marius-patrik", repo: "Andromeda-data" };
  const { gh: bypassGh } = mockGh(() => ({
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  }));
  const bypass = await doctor.auditBranchProtection(bypassGh, dataRepo, "main", { required: false });
  assert.deepEqual(bypass.map((finding) => finding.id), ["protection-main-admin-bypass"]);

  const { gh: inaccessibleGh } = mockGh(() => { throw Object.assign(new Error("forbidden"), { status: 403 }); });
  const inaccessible = await doctor.auditBranchProtection(inaccessibleGh, dataRepo, "main", { required: false });
  assert.deepEqual(inaccessible.map((finding) => finding.id), ["protection-main-unobservable"]);
});

test("main-only data repositories report an unowned dev branch as extra", async () => {
  const dataRepo = { owner: "marius-patrik", repo: "Andromeda-data" };
  const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "b" } }];
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/protection")) throw notFound();
    throw new Error(`unexpected ${requestPath}`);
  });
  const result = await doctor.auditBranchAndReleaseState(gh, dataRepo, { default_branch: "main", allow_auto_merge: false }, {
    branches, branchNames: new Set(["main", "dev"]), pulls: [], isData: true
  });
  assert.ok(result.findings.some((finding) => finding.id === "extra-branch-dev"));
});

test("main-only policy is restricted to the two canonical data repositories", () => {
  assert.equal(doctor.isMainOnlyDataRepository({ owner: "marius-patrik", repo: "Andromeda-data" }), true);
  assert.equal(doctor.isMainOnlyDataRepository({ owner: "MARIUS-PATRIK", repo: "DARKFACTORY-DATA" }), true);
  assert.equal(doctor.isMainOnlyDataRepository({ owner: "marius-patrik", repo: "product-data" }), false);
  assert.equal(doctor.isMainOnlyDataRepository({ owner: "another-owner", repo: "Andromeda-data" }), false);
});

test("the #241 shape remains diagnosed while its active head branch is exempt", async () => {
  const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "a" } }, { name: "dark-factory/managed-repository-setup", commit: { sha: "b" } }];
  const pull = { number: 241, head: { ref: "dark-factory/managed-repository-setup", sha: "b", repo: { full_name: "marius-patrik/DarkFactory" } }, base: { ref: "main" } };
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.endsWith("/pulls/241")) return { ...pull, updated_at: "2026-07-01T00:00:00Z", mergeable: false, mergeable_state: "dirty", html_url: "https://github.com/marius-patrik/DarkFactory/pull/241" };
    if (requestPath.includes("/commits/b/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "failure", html_url: "https://example.test/validate" }, { name: "Codex Review", status: "completed", conclusion: "failure" }] };
    if (requestPath.includes("/commits/b/status")) return { statuses: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
    branches, branchNames: new Set(branches.map((branch) => branch.name)), pulls: [pull], isData: false, now: "2026-07-13T00:00:00Z"
  });
  assert.ok(result.findings.some((finding) => finding.id === "pr-241-red"));
  assert.ok(result.findings.some((finding) => finding.id === "pr-241-not-mergeable"));
  assert.equal(result.findings.some((finding) => finding.id.includes("extra-branch-dark-factory")), false);
});

test("unknown completed check conclusions and malformed check payloads never become healthy", async () => {
  for (const checkRuns of [
    { check_runs: [{ name: "Validate", status: "completed", conclusion: "mystery" }] },
    { check_runs: "malformed" }
  ]) {
    const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "a" } }];
    const pull = { number: 77, head: { ref: "feature/check", sha: "c", repo: { full_name: "marius-patrik/DarkFactory" } }, base: { ref: "dev" } };
    const { gh } = mockGh((_method, requestPath) => {
      if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
      if (requestPath.includes("/protection")) return protectedBranch();
      if (requestPath.endsWith("/pulls/77")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://example.test/77" };
      if (requestPath.includes("/commits/c/check-runs")) return checkRuns;
      if (requestPath.includes("/commits/c/status")) return { statuses: [] };
      throw new Error(`unexpected ${requestPath}`);
    });
    const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
      branches, branchNames: new Set(["main", "dev"]), pulls: [pull], isData: false, now: "2026-07-13T01:00:00Z"
    });
    assert.ok(result.findings.some((finding) => finding.id === "pr-77-checks-unobservable"));
  }
});

test("inaccessible and individually malformed check evidence fails closed", async () => {
  for (const variant of ["inaccessible", "missing-name", "missing-context"]) {
    const branches = [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "a" } }];
    const pull = { number: 78, head: { ref: "feature/check", sha: "d", repo: { full_name: "marius-patrik/DarkFactory" } }, base: { ref: "dev" } };
    const { gh } = mockGh((_method, requestPath) => {
      if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
      if (requestPath.includes("/protection")) return protectedBranch();
      if (requestPath.endsWith("/pulls/78")) return { ...pull, updated_at: "2026-07-13T00:00:00Z", mergeable: true, mergeable_state: "clean", html_url: "https://example.test/78" };
      if (requestPath.includes("/commits/d/check-runs")) {
        if (variant === "inaccessible") throw Object.assign(new Error("forbidden"), { status: 403 });
        return { check_runs: [{ ...(variant === "missing-name" ? {} : { name: "Validate" }), status: "completed", conclusion: "success" }] };
      }
      if (requestPath.includes("/commits/d/status")) {
        return variant === "missing-context"
          ? { statuses: [{ state: "success" }] }
          : { statuses: [] };
      }
      throw new Error(`unexpected ${requestPath}`);
    });
    const result = await doctor.auditBranchAndReleaseState(gh, repo, { default_branch: "main", allow_auto_merge: true }, {
      branches, branchNames: new Set(["main", "dev"]), pulls: [pull], isData: false, now: "2026-07-13T01:00:00Z"
    });
    assert.ok(result.findings.some((finding) => finding.id === "pr-78-checks-unobservable"), variant);
  }
});

test("issue lane catches duplicate markers, stale blockers, missing blockers, self-reference, and cycles", () => {
  const issues = [
    { number: 1, state: "open", title: "One", body: "<!-- darkfactory:model -->\nBlocked-by: #2", updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/1" },
    { number: 2, state: "open", title: "Two", body: "<!-- darkfactory:model -->\nBlocked-by: #1", updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/2" },
    { number: 3, state: "open", title: "Three", body: "Blocked-by: #3, #9, #4", updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/3" },
    { number: 4, state: "closed", title: "Done", body: "", updated_at: "2026-07-12T00:00:00Z", html_url: "https://example.test/4" }
  ];
  const findings = doctor.auditIssueLane(repo, issues, { now: "2026-07-13T01:00:00Z" });
  const ids = new Set(findings.map((finding) => finding.id));
  assert.ok(ids.has("duplicate-issue-marker-darkfactory-model"));
  assert.ok(ids.has("issue-3-blocker-self-reference"));
  assert.ok(ids.has("issue-3-blocker-9-missing"));
  assert.ok(ids.has("issue-3-blocker-4-satisfied"));
  assert.ok(ids.has("issue-blocker-cycle-1-2"));
});

test("issue lane does not treat historical prose as an active supersession declaration", () => {
  const findings = doctor.auditIssueLane(repo, [{
    number: 11,
    state: "open",
    title: "Current contract",
    body: "Historical comments are superseded by #35, but this issue remains current.",
    updated_at: "2026-07-13T00:00:00Z"
  }], { now: "2026-07-13T01:00:00Z" });
  assert.equal(findings.some((finding) => finding.id === "superseded-issue-11-open"), false);
});

test("untrusted issue text cannot claim a doctor-owned marker", () => {
  const issue = {
    number: 99,
    state: "open",
    title: "spoof",
    body: "<!-- df-doctor:marius-patrik-darkfactory:fake -->",
    user: { login: "untrusted-user" },
    updated_at: "2026-07-13T00:00:00Z",
    html_url: "https://example.test/99"
  };
  const findings = doctor.auditIssueLane(repo, [issue], { now: "2026-07-13T01:00:00Z" });
  assert.ok(findings.some((finding) => finding.id === "untrusted-doctor-marker-99"));
  assert.equal(doctor.isTrustedDoctorIssue(issue), false);
});

test("issue lane detects stale readiness and record-class no-dispatch residue", () => {
  const findings = doctor.auditIssueLane(repo, [
    { number: 1, title: "Held", body: "", state: "open", labels: [{ name: "df:ready" }, { name: "df:blocked" }], updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/1" },
    { number: 2, title: "Dashboard", body: "<!-- df-dashboard:orchestration -->", state: "open", labels: [{ name: "dashboard" }], updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/2" },
    { number: 3, title: "Protected record", body: "<!-- darkfactory:decision-record -->", state: "open", labels: [{ name: "df:no-dispatch" }], updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/3" }
  ], { now: "2026-07-13T01:00:00Z" });
  const ids = new Set(findings.map((finding: { id: string }) => finding.id));

  assert.ok(ids.has("issue-1-stale-ready"));
  assert.ok(ids.has("issue-2-no-dispatch-missing"));
  assert.equal(ids.has("issue-3-no-dispatch-missing"), false);
});

test("issue lane compares bounded contracts without misclassifying qualified cross-repo blockers", () => {
  const contract = [
    "# Goal",
    "Implement deterministic guarded convergence for the managed repository while preserving every owner-authored scope boundary.",
    "# Acceptance",
    "- [ ] The exact observed state is checked before mutation and the postcondition is verified afterward."
  ].join("\n");
  const findings = doctor.auditIssueLane(repo, [
    { number: 21, state: "open", title: "First wording", body: `<!-- df-prd:first -->\n${contract}\nBlocked-by: marius-patrik/Andromeda#245`, updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/21" },
    { number: 22, state: "open", title: "Second wording", body: `<!-- df-prd:second -->\n${contract}`, updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/22" },
    { number: 23, state: "open", title: "Boilerplate", body: `${contract}\nTODO: implement as appropriate.`, updated_at: "2026-07-13T00:00:00Z", html_url: "https://example.test/23" }
  ], { now: "2026-07-13T01:00:00Z" });
  const ids = new Set(findings.map((finding) => finding.id));

  assert.ok(ids.has("duplicate-issue-contract-21-22"));
  assert.ok(ids.has("issue-23-contentless-contract"));
  assert.equal([...ids].some((id) => id.includes("blocker-245")), false);
  assert.deepEqual(doctor.extractBlockedByIssueRefs("Blocked-by: marius-patrik/Andromeda#245, #24", repo), [
    { repository: "marius-patrik/andromeda", number: 245 },
    { repository: "marius-patrik/darkfactory", number: 24 }
  ]);
});

test("label taxonomy audit accepts exact state and reports missing or drifted labels", async () => {
  const policy = JSON.stringify({ schemaVersion: 1, labels: [
    { name: "df:ready", color: "0E8A16", description: "Machine-evaluated" },
    { name: "df:no-dispatch", color: "6E7781", description: "Categorical hold" }
  ] });
  const exact = mockGh((_method, requestPath) => {
    if (requestPath.includes("/contents/managed-repository/.darkfactory/labels.json")) return content(policy);
    if (requestPath.includes("/labels?")) return [
      { name: "df:ready", color: "0e8a16", description: "Machine-evaluated" },
      { name: "df:no-dispatch", color: "6E7781", description: "Categorical hold" }
    ];
    throw new Error(`unexpected ${requestPath}`);
  });
  assert.deepEqual(await doctor.auditLabelTaxonomy(exact.gh, repo, repo), []);

  const drift = mockGh((_method, requestPath) => {
    if (requestPath.includes("/contents/managed-repository/.darkfactory/labels.json")) return content(policy);
    if (requestPath.includes("/labels?")) return [{ name: "df:ready", color: "ffffff", description: "wrong" }];
    throw new Error(`unexpected ${requestPath}`);
  });
  const ids = new Set((await doctor.auditLabelTaxonomy(drift.gh, repo, repo)).map((finding: { id: string }) => finding.id));
  assert.ok(ids.has("label-df-ready-drift"));
  assert.ok(ids.has("label-df-no-dispatch-missing"));
});

test("repository tree permits root policy authority but rejects nested copies", async () => {
  const findings = await doctor.auditRepositoryTree(repo, {
    truncated: false,
    tree: [
      { path: ".agents", type: "tree" },
      { path: ".agents/.project", type: "tree" },
      { path: ".agents/.project/STATUS.md", type: "blob" },
      { path: ".darkfactory", type: "tree" },
      { path: ".darkfactory/branching-policy.md", type: "blob" },
      { path: "packages/example/.agents/private.json", type: "blob" }
    ]
  });
  assert.deepEqual(findings.map((finding) => finding.id), ["state-boundary-packages-example-agents-private-json"]);
});

test("repository tree reports malformed entries without leaking their payload", async () => {
  const findings = await doctor.auditRepositoryTree(repo, {
    truncated: false,
    tree: [
      {},
      { path: "", type: "blob" },
      { path: "private/provider-input", type: "tag", secret: "must-not-leak" },
      { path: ".env", type: "blob" }
    ]
  });
  const malformed = findings.find((finding) => finding.id === "repository-tree-entry-malformed");
  assert.ok(malformed);
  assert.match(malformed.message, /3 malformed recursive tree entries/);
  assert.doesNotMatch(JSON.stringify(malformed), /private\/provider-input|must-not-leak|\"tag\"/);
  assert.ok(findings.some((finding) => finding.id === "sensitive-artifact-env"));
});

test("repository enumeration accepts complete pages and rejects malformed or capped evidence", async () => {
  const { gh: validGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/issues?")) return [{ number: 1 }, { number: 2, pull_request: { url: "https://example.test/pr/2" } }];
    return [];
  });
  assert.deepEqual(await doctor.listBranches(validGh, repo), []);
  assert.deepEqual(await doctor.listOpenPullRequests(validGh, repo), []);
  assert.deepEqual(await doctor.listDoctorIssues(validGh, repo), [{ number: 1 }]);

  for (const [name, list] of [
    ["branches", doctor.listBranches],
    ["open pull requests", doctor.listOpenPullRequests]
  ] as const) {
    const { gh } = mockGh(() => ({ unexpected: "object" }));
    await assert.rejects(() => list(gh, repo), new RegExp(`malformed ${name}`));
  }

  const fullPage = Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}` }));
  const { gh: cappedGh, calls } = mockGh(() => fullPage);
  await assert.rejects(() => doctor.listBranches(cappedGh, repo), /cannot prove complete branches enumeration/);
  assert.equal(calls.length, 10);
});

test("managed baseline audit detects drift and files that must be removed", async () => {
  const target = { owner: "marius-patrik", repo: "Andromeda" };
  const manifest = JSON.stringify({
    schemaVersion: 1,
    requiredFiles: ["managed.txt"],
    packageFiles: ["managed.txt"],
    removedFiles: ["retired.txt"]
  });
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/repos/marius-patrik/DarkFactory/contents/.darkfactory/managed-repository.json")) return content(manifest);
    if (requestPath.includes("/repos/marius-patrik/DarkFactory/contents/managed.txt")) return content("expected\n");
    if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/managed.txt")) return content("actual\n");
    if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/retired.txt")) return content("remove me\n");
    if (requestPath.includes("/repos/marius-patrik/Andromeda-data/contents/managed-repository/repositories/")) throw notFound();
    throw new Error(`unexpected ${requestPath}`);
  });
  const findings = await doctor.auditManagedFileDrift(gh, target, "main", repo);
  const ids = new Set(findings.map((finding) => finding.id));
  assert.ok(ids.has("managed-file-drift-managed-txt"));
  assert.ok(ids.has("managed-removed-file-retired-txt"));
});

test("managed baseline reports a release-control source contradiction without authorizing target deletion", async () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    requiredFiles: [],
    packageFiles: [],
    removedFiles: [".github/workflows/dark-factory-release.yml"]
  });
  const laneIssue = {
    number: 41,
    state: "open",
    body: "<!-- darkfactory:release-convergence-lane -->",
    html_url: "https://github.com/marius-patrik/DarkFactory/issues/41"
  };
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/repos/marius-patrik/DarkFactory/contents/.darkfactory/managed-repository.json")) return content(manifest);
    if (requestPath.includes("/repos/marius-patrik/Andromeda-data/contents/managed-repository/repositories/")) throw notFound();
    throw new Error(`release-control target must not be read while source policy contradicts #41: ${requestPath}`);
  });

  const findings = await doctor.auditManagedFileDrift(gh, repo, "main", repo, { issues: [laneIssue] });

  assert.ok(findings.some((finding) => finding.id === "source-policy-contradiction-release-controls" && finding.repair_class === "blocked"));
  assert.equal(findings.some((finding) => finding.id === "managed-removed-file-github-workflows-dark-factory-release-yml"), false);
});

test("machine runtime evidence is healthy only when every canonical prerequisite is proven", () => {
  const healthy = {
    agentsHomeExists: true,
    stateRepositoryOk: true,
    stateDoctorOk: true,
    launcherBound: true,
    versionObserved: true,
    packageRegistered: true,
    dfRunnable: true,
    runnerRegistered: true,
    runnerOnline: true,
    runnerPersistent: true,
    routeProbeOk: true,
    ledgerReachable: true,
    ledgerWritable: true
  };

  const current = doctor.auditMachineRuntimeEvidence(healthy);
  assert.deepEqual(current.findings, []);
  assert.equal(current.observations.length, 2);

  const absent = doctor.auditMachineRuntimeEvidence(Object.fromEntries(Object.keys(healthy).map((key) => [key, false])));
  const absentIds = new Set(absent.findings.map((finding) => finding.id));
  assert.ok(absentIds.has("agents-home-checkout-missing"));
  assert.ok(absentIds.has("darkfactory-package-unregistered"));
  assert.ok(absentIds.has("df-local-runner-missing"));
  assert.ok(absentIds.has("provider-route-probe-unavailable"));
  assert.ok(absentIds.has("darkfactory-ledger-write-unproven"));
  assert.equal(absent.findings.every((finding) => finding.repair_class === "blocked"), true);
  assert.deepEqual(
    doctor.auditMachineRuntimeEvidence(null).findings.map((finding) => finding.id),
    absent.findings.map((finding) => finding.id)
  );

  const degraded = doctor.auditMachineRuntimeEvidence({ ...healthy, runnerOnline: false, runnerPersistent: false, routeProbeOk: false });
  const degradedIds = new Set(degraded.findings.map((finding) => finding.id));
  assert.ok(degradedIds.has("df-local-runner-offline"));
  assert.ok(degradedIds.has("df-local-runner-persistence-unproven"));
  assert.ok(degradedIds.has("provider-route-probe-unavailable"));
  assert.equal(degradedIds.has("df-local-runner-missing"), false);

  const failedStateDoctor = doctor.auditMachineRuntimeEvidence({ ...healthy, stateDoctorOk: false });
  assert.deepEqual(failedStateDoctor.findings.map((finding) => finding.id), ["agents-state-doctor-failed"]);
});

test("PRD cross-review covers missing, duplicate, stale, completed, and unbacked issue contracts", async () => {
  const prd = [
    "# Product",
    "",
    "## Milestones",
    "- [ ] **M1 First**: first lane",
    "- [x] **M2 Done**: completed lane",
    "- [ ] **M3 Missing**: missing lane"
  ].join("\n");
  const issues = [
    { number: 1, state: "open", body: "<!-- df-prd:milestones-m1 -->", labels: [] },
    { number: 2, state: "open", body: "<!-- df-prd:milestones-m1 -->", labels: [] },
    { number: 3, state: "open", body: "<!-- df-prd:milestones-removed -->", labels: [] },
    { number: 4, state: "open", body: "<!-- df-prd:milestones-m2 -->", labels: [] },
    { number: 5, state: "open", body: "ordinary work", labels: [] },
    { number: 6, state: "open", body: "decision record", labels: [{ name: "df:no-dispatch" }] }
  ];
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/contents/PRD.md")) return content(prd);
    throw new Error(`unexpected ${requestPath}`);
  });

  const findings = await doctor.auditPrdDrift(gh, repo, "main", issues);
  const ids = new Set(findings.map((finding) => finding.id));

  assert.ok(ids.has("prd-item-df-prd-milestones-m1-issue-duplicate"));
  assert.ok(ids.has("prd-item-df-prd-milestones-m3-issue-missing"));
  assert.ok(ids.has("issue-3-prd-marker-stale"));
  assert.ok(ids.has("issue-4-prd-item-completed"));
  assert.ok(ids.has("issue-5-prd-backing-missing"));
  assert.equal(ids.has("issue-6-prd-backing-missing"), false);
});

test("PRD cross-review includes product PRDs and excludes template sources", async () => {
  const rootPrd = "# Root\n\n## Milestones\n";
  const packagePrd = "# Core\n\n## Milestones\n- [ ] **M1 Package**: package lane\n";
  const issues = [{
    number: 11,
    state: "open",
    body: "<!-- df-prd:packages-core-prd-md-milestones-m1 -->",
    labels: []
  }];
  const { gh, calls } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/contents/PRD.md")) return content(rootPrd);
    if (requestPath.includes("/contents/packages/core/PRD.md")) return content(packagePrd);
    throw new Error(`template PRD must not be inspected: ${requestPath}`);
  });

  const findings = await doctor.auditPrdDrift(gh, repo, "main", issues, {
    tree: {
      tree: [
        { path: "PRD.md", type: "blob" },
        { path: "packages/core/PRD.md", type: "blob" },
        { path: "templates/example/PRD.md", type: "blob" }
      ]
    }
  });

  assert.equal(findings.some((finding) => finding.id.includes("packages-core")), false);
  assert.equal(findings.some((finding) => finding.id === "issue-11-prd-marker-stale"), false);
  assert.equal(calls.some((call) => call.path.includes("templates/example")), false);
});

test("issue reality fails closed for missing and unobservable referenced PRs and runs", async () => {
  const issues = [{
    number: 7,
    state: "open",
    body: [
      "https://github.com/marius-patrik/DarkFactory/pull/8",
      "https://github.com/marius-patrik/DarkFactory/actions/runs/9",
      "https://github.com/marius-patrik/DarkFactory/pull/10",
      "https://github.com/someone/else/pull/11"
    ].join("\n"),
    html_url: "https://github.com/marius-patrik/DarkFactory/issues/7"
  }];
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.endsWith("/pulls/8")) return { number: 8 };
    if (requestPath.endsWith("/actions/runs/9")) throw notFound();
    if (requestPath.endsWith("/pulls/10")) throw Object.assign(new Error("forbidden"), { status: 403 });
    throw new Error(`unexpected ${requestPath}`);
  });

  const findings = await doctor.auditIssueReality(gh, repo, issues);
  const ids = new Set(findings.map((finding) => finding.id));

  assert.ok(ids.has("issue-7-referenced-run-9-missing"));
  assert.ok(ids.has("issue-7-referenced-pull-10-unobservable"));
  assert.equal(ids.has("issue-7-referenced-pull-8-missing"), false);
  assert.equal(findings.find((finding) => finding.id.endsWith("unobservable"))?.repair_class, "blocked");
});

test("issue reality verifies same-owner cross-repo blockers and explicit PR and settings claims", async () => {
  const issues = [{
    number: 12,
    state: "open",
    body: [
      "Blocked-by: marius-patrik/Andromeda#245",
      "status: merged https://github.com/marius-patrik/Andromeda/pull/246",
      "auto-merge: enabled https://github.com/marius-patrik/Andromeda/settings/branches",
      "Blocked-by: someone/external#9"
    ].join("\n"),
    html_url: "https://github.com/marius-patrik/DarkFactory/issues/12"
  }];
  const { gh, calls } = mockGh((_method, requestPath) => {
    if (requestPath.endsWith("/repos/marius-patrik/andromeda/issues/245")) return { number: 245, state: "open" };
    if (requestPath.endsWith("/repos/marius-patrik/andromeda/pulls/246")) return { number: 246, state: "open", merged_at: null };
    if (requestPath.endsWith("/repos/marius-patrik/andromeda")) return { default_branch: "main" };
    throw new Error(`unexpected ${requestPath}`);
  });

  const findings = await doctor.auditIssueReality(gh, repo, issues);
  const ids = new Set(findings.map((finding) => finding.id));

  assert.ok(ids.has("issue-12-referenced-pull-246-state-drift"));
  assert.ok(ids.has("issue-12-referenced-settings-repository-state-drift"));
  assert.equal(findings.find((finding) => finding.id === "issue-12-referenced-settings-repository-state-drift")?.repair_class, "blocked");
  assert.equal(calls.some((call) => call.path.includes("someone/external")), false);
});

test("submodule audit distinguishes invalid URLs, missing gitlinks, and released-pointer drift", async () => {
  const parent = { owner: "marius-patrik", repo: "Andromeda" };
  const oldSha = "1".repeat(40);
  const newSha = "2".repeat(40);
  const modules = [
    '[submodule "bad-url"]',
    "  path = plugins/bad",
    "  url = file:///machine/local",
    '[submodule "missing-link"]',
    "  path = plugins/missing",
    "  url = https://github.com/marius-patrik/Missing.git",
    '[submodule "drift"]',
    "  path = plugins/drift",
    "  url = https://github.com/marius-patrik/Child.git",
    "  branch = dev"
  ].join("\n");
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.gitmodules")) return content(modules);
    if (requestPath.includes("/contents/plugins/missing")) throw notFound();
    if (requestPath.includes("/contents/plugins/drift")) return { type: "submodule", sha: oldSha };
    if (requestPath === "/repos/marius-patrik/Child") return { default_branch: "main" };
    if (requestPath.endsWith("/repos/marius-patrik/Child/commits/main")) return { sha: newSha };
    throw new Error(`unexpected ${requestPath}`);
  });
  const findings = await doctor.auditSubmoduleState(gh, parent, "main");
  const ids = new Set(findings.map((finding) => finding.id));
  assert.ok(ids.has("submodule-plugins-bad-url-invalid"));
  assert.ok(ids.has("submodule-plugins-missing-gitlink-missing-main"));
  assert.ok(ids.has("submodule-plugins-drift-branch-drift"));
  assert.ok(ids.has("submodule-plugins-drift-pointer-drift-main"));
});

test("root-layout and naming fixtures catch Andromeda and DarkFactory contract drift", async () => {
  const andromeda = { owner: "marius-patrik", repo: "Andromeda" };
  const modules = '[submodule "Wrong"]\n path = plugins/DarkFactory\n url = https://github.com/marius-patrik/Wrong.git\n[submodule "Extra"]\n path = extras/Extra\n url = https://github.com/marius-patrik/Extra.git\n';
  const { gh: andromedaGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/.gitmodules")) return content(modules);
    if (requestPath.includes("/README.md")) return content("# Wrong\n");
    throw new Error(`unexpected ${requestPath}`);
  });
  const andromedaFindings = await doctor.auditRootLayout(andromedaGh, andromeda, "main", {
    tree: [{ path: "apps", type: "tree" }, { path: "plugins/DarkFactory", type: "blob" }]
  });
  const andromedaIds = new Set(andromedaFindings.map((finding) => finding.id));
  assert.ok(andromedaIds.has("andromeda-root-plugins-missing"));
  assert.ok(andromedaIds.has("andromeda-submodule-plugins-darkfactory-identity"));
  assert.ok(andromedaIds.has("andromeda-submodule-plugins-darkfactory-mode"));
  assert.ok(andromedaIds.has("andromeda-submodule-unexpected-extras-extra"));
  assert.ok(andromedaIds.has("andromeda-product-name"));

  const { gh: darkFactoryGh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/README.md")) return content("# Wrong\n");
    if (requestPath.includes("/package.json")) return content('{"name":"wrong"}');
    throw new Error(`unexpected ${requestPath}`);
  });
  const darkFactoryFindings = await doctor.auditRootLayout(darkFactoryGh, repo, "main", { tree: [] });
  assert.deepEqual(darkFactoryFindings.map((finding) => finding.id).sort(), ["darkfactory-package-name", "darkfactory-product-name"]);
});

test("runtime authority and prerequisites fail closed on direct providers, missing secrets, and offline runners", async () => {
  const { gh } = mockGh((_method, requestPath) => {
    if (requestPath.includes("/.github/workflows/df-work.yml")) return content("codex exec --dangerously-bypass");
    if (requestPath.includes("/contents/AGENTS.md")) return content("No shared authority documented.");
    if (requestPath.includes("/contents/.darkfactory/enforcement-rules.json")) return content("{");
    if (requestPath.includes("/contents/.darkfactory/managed-repository.json")) return content('{"requiredSecrets":["REQUIRED_TOKEN"]}');
    if (requestPath.includes("/actions/secrets")) return { secrets: [] };
    if (requestPath.includes("/actions/runners")) return { runners: [{ status: "offline", labels: [{ name: "df-local" }] }] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const authority = await doctor.auditRuntimeAuthority(gh, repo, "main", repo);
  const prerequisites = await doctor.auditPrerequisites(gh, repo, "main", { controlRepo: repo });
  const ids = new Set([...authority, ...prerequisites].map((finding) => finding.id));
  assert.ok(ids.has("canonical-launcher-binding-invalid"));
  assert.ok(ids.has("direct-provider-cli-in-worker"));
  assert.ok(ids.has("agents-home-authority-undocumented"));
  assert.ok(ids.has("enforcement-rules-invalid"));
  assert.ok(ids.has("required-secret-required-token-missing"));
  assert.ok(ids.has("df-local-runner-offline"));
});

test("local checkout audit detects root dirt, recursive submodule pointer drift, and nested dirt without leaking host paths", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "df-doctor-local-"));
  const root = path.join(temp, "root");
  const child = path.join(temp, "child-source");
  const runGit = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  try {
    await mkdir(root, { recursive: true });
    await mkdir(child, { recursive: true });
    runGit(child, ["init"]);
    await writeFile(path.join(child, "child.txt"), "one\n");
    runGit(child, ["add", "child.txt"]);
    runGit(child, ["-c", "user.name=Doctor Test", "-c", "user.email=doctor@example.test", "commit", "-m", "child"]);

    runGit(root, ["init"]);
    runGit(root, ["remote", "add", "origin", "https://github.com/marius-patrik/DarkFactory.git"]);
    await writeFile(path.join(root, "README.md"), "root\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["-c", "user.name=Doctor Test", "-c", "user.email=doctor@example.test", "commit", "-m", "root"]);
    runGit(root, ["-c", "protocol.file.allow=always", "submodule", "add", child, "modules/child"]);
    runGit(root, ["add", ".gitmodules", "modules/child"]);
    runGit(root, ["-c", "user.name=Doctor Test", "-c", "user.email=doctor@example.test", "commit", "-m", "submodule"]);

    const nested = path.join(root, "modules", "child");
    await writeFile(path.join(nested, "child.txt"), "two\n");
    runGit(nested, ["add", "child.txt"]);
    runGit(nested, ["-c", "user.name=Doctor Test", "-c", "user.email=doctor@example.test", "commit", "-m", "advance"]);
    await writeFile(path.join(nested, "untracked.txt"), "dirty\n");
    await writeFile(path.join(root, "root-untracked.txt"), "dirty\n");

    const result = doctor.auditLocalCheckout(root, repo);
    const ids = new Set(result.findings.map((finding) => finding.id));
    assert.ok(ids.has("local-checkout-dirty"));
    assert.ok(ids.has("local-submodule-modules-child-pointer"));
    assert.ok(ids.has("local-submodule-modules-child-dirty"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

    const missing = doctor.auditLocalCheckout(path.join(temp, "private-missing"), repo);
    assert.doesNotMatch(JSON.stringify(missing), /private-missing|df-doctor-local/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("worker session isolation reads canonical state and catches escaped cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-doctor-sessions-"));
  try {
    for (const [id, workdir] of [["good", path.join(tmpdir(), "df-work-good", "repo")], ["bad", "C:\\Users\\patrik\\marius-patrik\\Andromeda"]]) {
      const session = path.join(root, "sessions", id);
      await mkdir(session, { recursive: true });
      await writeFile(path.join(session, "state.json"), JSON.stringify({ sessionId: id, workdir, lastTurnAt: "2026-07-13T00:00:00Z" }));
      await writeFile(path.join(session, "transcript.json"), JSON.stringify({ messages: [{ role: "user", content: "Read .darkfactory/df-task-brief.md and implement that task in the current repository. Continue safely." }] }));
    }
    const result = doctor.auditWorkerSessionIsolation(root, { now: "2026-07-13T01:00:00Z" });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, "worker-session-workdir-isolation");
    assert.match(result.findings[0].message, /^1 canonical worker session/);
    assert.doesNotMatch(JSON.stringify(result), /bad|good|C:\\Users|patrik|Andromeda/i);
    assert.doesNotMatch(doctor.doctorIssueBody("marius-patrik/DarkFactory", result.findings[0]), /bad|good|C:\\Users|Andromeda/i);

    const missing = doctor.auditWorkerSessionIsolation(path.join(root, "missing-authority"));
    assert.equal(missing.findings[0].id, "worker-session-state-missing");
    assert.doesNotMatch(missing.findings[0].message, /missing-authority|\\|:\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose mode performs no GitHub writes", async () => {
  const { gh, calls } = mockGh((method, requestPath) => {
    if (method !== "GET") throw new Error(`unexpected write ${method} ${requestPath}`);
    if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main", allow_auto_merge: true, archived: false, disabled: false, pushed_at: "2026-07-13T00:00:00Z" };
    if (requestPath.includes("/branches?")) return requestPath.endsWith("page=1") ? [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "a" } }] : [];
    if (requestPath.includes("/pulls?state=open")) return [];
    if (requestPath.includes("/issues?state=all")) return [];
    if (requestPath.endsWith("/git/trees/main?recursive=1")) return { truncated: false, tree: [{ path: "README.md", type: "blob" }] };
    if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/secrets")) return { secrets: [] };
    if (requestPath.includes("/actions/runners")) return { runners: [{ status: "online", labels: [{ name: "df-local" }] }] };
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [{ name: "Validate", head_sha: "a", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/commits/a/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", app: { id: 15368 } }, { name: "Codex Review", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/commits/a/status")) return { statuses: [] };
    if (requestPath.includes("/commits?sha=")) return [];
    if (requestPath.includes("/contents/.github/workflows/df-work.yml")) return content("AGENTS_HOME bin\\agents.ps1 state doctor --json");
    if (requestPath.includes("/contents/AGENTS.md")) return content("Use AGENTS_HOME.");
    if (requestPath.includes("/contents/README.md")) return content("# DarkFactory\n");
    if (requestPath.includes("/contents/package.json")) return content('{"name":"@agent-os/darkfactory"}');
    if (requestPath.includes("/contents/PRD.md")) return content("# PRD\n");
    if (requestPath.includes("/contents/.darkfactory/enforcement-rules.json")) return content('{"rules":[{"id":"no-admin-bypass","enabled":true,"severity":"block"}]}');
    if (requestPath.includes("/contents/managed-repository/.darkfactory/labels.json")) return content(LABEL_POLICY);
    if (requestPath.includes("/labels?") && requestPath.endsWith("page=1")) return JSON.parse(LABEL_POLICY).labels;
    if (requestPath.includes("/contents/.darkfactory/") || requestPath.includes("/contents/.gitmodules") || requestPath.includes("/contents/.github/workflows/sync-managed-repos.yml") || requestPath.includes("/contents/.agents/") || requestPath.includes("/contents/src/managed-files.ts")) throw notFound();
    throw new Error(`unexpected ${method} ${requestPath}`);
  });
  const reports = await doctor.runRepositoryDoctor(gh, {
    mode: "diagnose",
    trigger: "test",
    controlRepo: repo,
    target: repo,
    registry: { schemaVersion: 1, repositories: { "marius-patrik/DarkFactory": { state: "active" } } }
  });
  assert.equal(reports[0].read_only, true);
  assert.equal(reports[0].trigger, "test");
  assert.equal(calls.every((call) => call.method === "GET"), true);
});

test("report mode routes issue writes to target authority and contents writes only to scoped ledger authority", async () => {
  let nextIssue = 100;
  const events: string[] = [];
  const { gh: targetGh, calls: targetCalls } = mockGh((method, requestPath) => {
    events.push(`target:${method}:${requestPath}`);
    if (method === "POST" && requestPath === "/repos/marius-patrik/DarkFactory/issues") {
      nextIssue += 1;
      return { number: nextIssue, html_url: `https://example.test/${nextIssue}` };
    }
    if (method !== "GET") throw new Error(`unexpected target write ${method} ${requestPath}`);
    if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main", allow_auto_merge: true, archived: false, disabled: false, pushed_at: "2026-07-13T00:00:00Z" };
    if (requestPath.includes("/branches?")) return requestPath.endsWith("page=1") ? [{ name: "main", commit: { sha: "a" } }, { name: "dev", commit: { sha: "a" } }] : [];
    if (requestPath.includes("/pulls?state=open")) return [];
    if (requestPath.includes("/issues?state=all")) return [];
    if (requestPath.includes("/labels?") && requestPath.endsWith("page=1")) return JSON.parse(LABEL_POLICY).labels;
    if (requestPath.endsWith("/git/trees/main?recursive=1")) return { truncated: false, tree: [{ path: "README.md", type: "blob" }] };
    if (requestPath.endsWith("/compare/main...dev")) return { status: "identical", ahead_by: 0, behind_by: 0 };
    if (requestPath.includes("/protection")) return protectedBranch();
    if (requestPath.includes("/actions/secrets")) return { secrets: [] };
    if (requestPath.includes("/actions/runners")) return { runners: [{ status: "online", labels: [{ name: "df-local" }] }] };
    if (requestPath.includes("/actions/runs?")) return { workflow_runs: [{ name: "Validate", head_sha: "a", status: "completed", conclusion: "success" }] };
    if (requestPath.includes("/commits/a/check-runs")) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", app: { id: 15368 } }, { name: "Codex Review", status: "completed", conclusion: "success", app: { id: 15368 } }] };
    if (requestPath.includes("/commits/a/status")) return { statuses: [] };
    if (requestPath.includes("/commits?sha=")) return [];
    if (requestPath.includes("/contents/.github/workflows/df-work.yml")) return content("AGENTS_HOME bin\\agents.ps1 state doctor --json");
    if (requestPath.includes("/contents/AGENTS.md")) return content("Use AGENTS_HOME.");
    if (requestPath.includes("/contents/README.md")) return content("# DarkFactory\n");
    if (requestPath.includes("/contents/package.json")) return content('{"name":"@agent-os/darkfactory"}');
    if (requestPath.includes("/contents/PRD.md")) return content("# PRD\n");
    if (requestPath.includes("/contents/.darkfactory/enforcement-rules.json")) return content('{"rules":[{"id":"no-admin-bypass","enabled":true,"severity":"block"}]}');
    if (requestPath.includes("/contents/managed-repository/.darkfactory/labels.json")) return content(LABEL_POLICY);
    if (requestPath.includes("/labels?") && requestPath.endsWith("page=1")) return JSON.parse(LABEL_POLICY).labels;
    if (requestPath.includes("/contents/.darkfactory/") || requestPath.includes("/contents/.gitmodules") || requestPath.includes("/contents/.github/workflows/sync-managed-repos.yml") || requestPath.includes("/contents/.agents/") || requestPath.includes("/contents/src/managed-files.ts")) throw notFound();
    throw new Error(`unexpected target ${method} ${requestPath}`);
  });
  const { gh: ledgerGh, calls: ledgerCalls } = mockGh((method, requestPath) => {
    events.push(`ledger:${method}:${requestPath}`);
    assert.match(requestPath, /^\/repos\/marius-patrik\/darkfactory-data\/contents\/runs\//);
    if (method === "GET") throw notFound();
    if (method === "PUT") return {};
    throw new Error(`unexpected ledger ${method} ${requestPath}`);
  });

  const reports = await doctor.runRepositoryDoctor(targetGh, {
    mode: "report",
    trigger: "test",
    controlRepo: repo,
    target: repo,
    ledgerGithub: ledgerGh,
    registry: { schemaVersion: 1, repositories: { "marius-patrik/DarkFactory": { state: "active" } } }
  });

  assert.ok(reports[0].actions.some((action) => action.action === "write-doctor-ledger"));
  assert.ok(targetCalls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/issues"));
  assert.equal(targetCalls.some((call) => call.method !== "GET" && /\/contents\//.test(call.path)), false);
  assert.equal(targetCalls.some((call) => call.method !== "GET" && /\/labels(?:[/?]|$)/.test(call.path)), false);
  const ledgerWrites = ledgerCalls.filter((call) => call.method === "PUT");
  assert.equal(ledgerWrites.length, 2);
  assert.equal(ledgerCalls.every((call) => /\/repos\/marius-patrik\/darkfactory-data\/contents\//.test(call.path)), true);
  const admissionIndex = events.findIndex((event) => event.includes("ledger:PUT:") && event.includes("repo-doctor-admission"));
  const firstTargetWriteIndex = events.findIndex((event) => /^target:(POST|PATCH):/.test(event));
  assert.ok(admissionIndex >= 0 && admissionIndex < firstTargetWriteIndex);

  const ledgers = ledgerWrites.map((call) => JSON.parse(Buffer.from((call.body as { content: string }).content, "base64").toString("utf8")));
  const admission = ledgers.find((ledger) => ledger.phase === "admission");
  const completion = ledgers.find((ledger) => ledger.phase === "completion");
  assert.ok(admission.planned_actions.some((action: { action: string }) => action.action === "retire-legacy-audit-issues"));
  assert.ok(admission.actions.some((action: { action: string; state: string }) => action.action === "retire-legacy-audit-issues" && action.state === "admitted"));
  assert.ok(completion.actions.some((action: { action: string }) => action.action === "create-repair-issue"));
});

test("ledger failure leaves legacy aggregate audit issues untouched", async () => {
  const legacy = {
    number: 42,
    state: "open",
    body: "<!-- df-audit:marius-patrik-darkfactory -->",
    user: { login: "darkfactory-agent[bot]" },
    html_url: "https://example.test/42"
  };
  const { gh: targetGh, calls: targetCalls } = mockGh((method, requestPath) => {
    if (method !== "GET") throw new Error(`legacy issue was mutated before ledger success: ${method} ${requestPath}`);
    if (requestPath.includes("/labels?")) return doctor.DOCTOR_REPORT_LABEL_NAMES.map((name) => ({ name }));
    if (requestPath.includes("/issues?state=all")) return [legacy];
    throw new Error(`unexpected ${requestPath}`);
  });
  const { gh: failingLedger } = mockGh((method) => {
    if (method === "GET") throw notFound();
    throw Object.assign(new Error("ledger write failed"), { status: 500 });
  });
  const report = {
    mode: "report",
    trigger: "test",
    source_refs: {},
    findings: [],
    observations: [],
    actions: [],
    token_usage: { model_calls: 0 }
  };

  await assert.rejects(() => doctor.publishDoctorReport(targetGh, failingLedger, repo, report), /ledger write failed/);
  assert.equal(targetCalls.every((call) => call.method === "GET"), true);
  assert.equal(targetCalls.filter((call) => call.path.includes("issues?state=all")).length, 1);
});

test("malformed reconciliation enumeration aborts report publication before any write", async () => {
  const { gh: targetGh, calls: targetCalls } = mockGh((method, requestPath) => {
    assert.equal(method, "GET");
    if (requestPath.includes("/labels?")) return doctor.DOCTOR_REPORT_LABEL_NAMES.map((name) => ({ name }));
    if (requestPath.includes("/issues?state=all")) return { items: [] };
    throw new Error(`unexpected ${requestPath}`);
  });
  const { gh: ledgerGh, calls: ledgerCalls } = mockGh(() => {
    throw new Error("ledger must remain untouched");
  });
  const report = {
    mode: "report",
    trigger: "test",
    source_refs: {},
    findings: [doctor.doctorFinding("current-drift", "branch policy", "current")],
    observations: [],
    actions: [],
    token_usage: { model_calls: 0 }
  };

  await assert.rejects(() => doctor.publishDoctorReport(targetGh, ledgerGh, repo, report), /malformed all issues page/);
  assert.equal(targetCalls.every((call) => call.method === "GET"), true);
  assert.equal(ledgerCalls.length, 0);
  assert.deepEqual(report.actions, []);
});

test("completion ledger records legacy retirement after admitted issue mutations", async () => {
  const legacy = {
    number: 42,
    state: "open",
    body: "<!-- df-audit:marius-patrik-darkfactory -->",
    user: { login: "darkfactory-agent[bot]" },
    html_url: "https://example.test/42"
  };
  const { gh: targetGh } = mockGh((method, requestPath) => {
    if (method === "GET" && requestPath.includes("/labels?")) return doctor.DOCTOR_REPORT_LABEL_NAMES.map((name) => ({ name }));
    if (method === "GET" && requestPath.includes("issues?state=all")) return requestPath.endsWith("page=1") ? [legacy] : [];
    if (method === "POST" || method === "PATCH") return {};
    throw new Error(`unexpected ${method} ${requestPath}`);
  });
  const { gh: ledgerGh, calls: ledgerCalls } = mockGh((method) => {
    if (method === "GET") throw notFound();
    if (method === "PUT") return {};
    throw new Error(`unexpected ledger method ${method}`);
  });
  const report = {
    mode: "report",
    trigger: "test",
    source_refs: {},
    findings: [],
    observations: [],
    actions: [],
    token_usage: { model_calls: 0 }
  };

  await doctor.publishDoctorReport(targetGh, ledgerGh, repo, report);
  const completionCall = ledgerCalls.find((call) => call.method === "PUT" && call.path.includes("-repo-doctor.json"));
  assert.ok(completionCall);
  const completion = JSON.parse(Buffer.from((completionCall.body as { content: string }).content, "base64").toString("utf8"));
  assert.ok(completion.actions.some((action: { action: string; issue?: { number: number } }) => action.action === "close-legacy-audit-issue" && action.issue?.number === 42));
  assert.equal(report.actions.at(-1).action, "write-doctor-ledger");
});

test("report issue reconciliation is marker-idempotent and closes resolved findings", async () => {
  const current = doctor.doctorFinding("current-drift", "branch policy", "current");
  const existing = { number: 7, state: "open", body: "<!-- df-doctor:marius-patrik-darkfactory:current-drift -->", user: { login: "mp-agents[bot]" }, html_url: "https://example.test/7" };
  const resolved = { number: 8, state: "open", body: "<!-- df-doctor:marius-patrik-darkfactory:old-drift -->", user: { login: "mp-agents[bot]" }, html_url: "https://example.test/8" };
  const { gh, calls } = mockGh((method, requestPath) => {
    if (method === "GET" && requestPath.includes("issues?state=all") && requestPath.endsWith("page=1")) return [existing, resolved];
    if (method === "GET" && requestPath.includes("issues?state=all") && requestPath.endsWith("page=2")) return [];
    if (method === "PATCH" || method === "POST") return {};
    throw new Error(`unexpected ${method} ${requestPath}`);
  });
  const actions = await doctor.reconcileDoctorIssues(gh, repo, [current]);
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/issues"), false);
  assert.ok(actions.some((action) => action.action === "update-repair-issue"));
  assert.ok(actions.some((action) => action.action === "close-resolved-repair-issue"));
});

test("generic GitHub Actions issue text cannot claim repository-doctor ownership", () => {
  const marker = "<!-- df-doctor:marius-patrik-darkfactory:spoofed -->";
  assert.equal(doctor.isTrustedDoctorIssue({ body: marker, user: { login: "github-actions[bot]" } }), false);
  assert.equal(doctor.isTrustedDoctorIssue({ body: marker, user: { login: "darkfactory-agent[bot]" } }), true);
  assert.equal(doctor.isTrustedDoctorIssue({ body: marker, user: { login: "mp-agents[bot]" } }), true);
});

test("doctor issue sources are unambiguous across repositories", () => {
  const body = doctor.doctorIssueBody("marius-patrik/Andromeda", doctor.doctorFinding("drift", "policy", "observed", { severity: "critical" }));
  assert.match(body, /Priority: `P0`/);
  assert.match(body, /\[marius-patrik\/DarkFactory#12\]\(https:\/\/github\.com\/marius-patrik\/DarkFactory\/issues\/12\)/);
  assert.match(body, /\[marius-patrik\/DarkFactory#35\]\(https:\/\/github\.com\/marius-patrik\/DarkFactory\/issues\/35\)/);
  assert.doesNotMatch(body, /foundation: #12|epic: #35/);
  assert.deepEqual([...doctor.DOCTOR_REPORT_LABEL_NAMES].sort(), ["P0", "P1", "P2", "df:class:mechanical", "df:doctor"]);
});

test("live DarkFactory App actor creates, updates, then closes one stable issue across consecutive reports", async () => {
  const issues: any[] = [];
  const calls: any[] = [];
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (method === "GET" && requestPath.includes("issues?state=all")) return issues.map((issue) => ({ ...issue }));
      if (method === "POST" && requestPath === "/repos/marius-patrik/DarkFactory/issues") {
        const issue = {
          number: 10,
          state: "open",
          title: body.title,
          body: body.body,
          labels: body.labels,
          user: { login: "darkfactory-agent[bot]" },
          html_url: "https://example.test/10"
        };
        issues.push(issue);
        return { ...issue };
      }
      if (method === "PATCH" && requestPath === "/repos/marius-patrik/DarkFactory/issues/10") {
        Object.assign(issues[0], body);
        return { ...issues[0] };
      }
      if (method === "POST" && requestPath === "/repos/marius-patrik/DarkFactory/issues/10/comments") return {};
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  const finding = doctor.doctorFinding("stable-live-actor", "health", "observed");

  const created = await doctor.reconcileDoctorIssues(gh, repo, [finding]);
  assert.deepEqual(created.map((action) => action.action), ["create-repair-issue"]);
  assert.equal(doctor.isTrustedDoctorIssue(issues[0]), true);

  const updated = await doctor.reconcileDoctorIssues(gh, repo, [finding]);
  assert.deepEqual(updated.map((action) => action.action), ["update-repair-issue"]);
  assert.equal(issues.length, 1);

  const closed = await doctor.reconcileDoctorIssues(gh, repo, []);
  assert.deepEqual(closed.map((action) => action.action), ["close-resolved-repair-issue"]);
  assert.equal(issues[0].state, "closed");
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/issues").length, 1);
});

test("human and JSON formats preserve deterministic zero-token evidence", () => {
  const reports = [{ target_repository: "marius-patrik/DarkFactory", mode: "diagnose", read_only: true, findings: [], observations: ["checked"], token_usage: { model_calls: 0 } }];
  assert.match(doctor.formatDoctorReports(reports), /HEALTHY \(diagnose, read_only=true\)/);
  assert.equal(JSON.parse(JSON.stringify(reports))[0].token_usage.model_calls, 0);
});
