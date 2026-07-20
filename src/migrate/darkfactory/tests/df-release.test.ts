import assert from "node:assert/strict";
import test from "node:test";

// @ts-ignore Native ESM workflow controller.
const release: any = await import("../.github/scripts/df-release.mjs");

const SHA = {
  main: "1111111111111111111111111111111111111111",
  dev: "2222222222222222222222222222222222222222",
  merge: "3333333333333333333333333333333333333333"
};
const TREE = {
  converged: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  different: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
};

test("release convergence classifies every branch relation and exposes missing dev", () => {
  assert.equal(release.classifyConvergence(SHA.main, SHA.main, null), "identical");
  assert.equal(
    release.classifyConvergence(SHA.main, SHA.dev, { status: "behind", ahead_by: 0, behind_by: 1 }, TREE.converged, TREE.converged),
    "tree-identical"
  );
  assert.equal(release.classifyConvergence(SHA.main, SHA.dev, { status: "ahead", ahead_by: 2, behind_by: 0 }), "dev-ahead");
  assert.equal(release.classifyConvergence(SHA.main, SHA.dev, { status: "behind", ahead_by: 0, behind_by: 2 }), "main-ahead");
  assert.equal(release.classifyConvergence(SHA.main, SHA.dev, { status: "diverged", ahead_by: 1, behind_by: 1 }), "diverged");
  assert.equal(release.classifyConvergence(SHA.main, null, null), "missing-dev");
  assert.equal(release.classifyConvergence(null, SHA.dev, null), "missing-main");
  assert.equal(release.classifyConvergence(null, null, null), "missing-both");
  assert.equal(release.classifyConvergence(SHA.main, SHA.dev, { status: "ahead" }), "unobservable");
});

test("fleet release exits nonzero when any repository is blocked or failed", () => {
  assert.equal(release.fleetReleaseHasBlockedResult([{ status: "verified" }, { status: "waiting-for-green" }]), false);
  for (const status of ["failed", "blocked", "owner-required"]) {
    assert.equal(release.fleetReleaseHasBlockedResult([{ status: "verified" }, { status }]), true, status);
  }
});

test("release policy is exact, declares independent publication mode, and requires both gates", () => {
  const policy = release.validateReleasePolicy(releasePolicy());
  assert.equal(policy.mode, "branch-only");
  assert.deepEqual(policy.requiredChecks, ["Validate", "DarkFactory Autoreview"]);
  assert.throws(() => release.validateReleasePolicy({ ...releasePolicy(), unknown: true }), /unknown or missing/);
  assert.throws(() => release.validateReleasePolicy({ ...releasePolicy(), requiredChecks: ["Validate"] }), /must require/);
  assert.throws(() => release.validateReleasePolicy({ ...releasePolicy(), mode: "tagged", tagPattern: null }), /requires a tag pattern/);
  const tagged = {
    ...releasePolicy(),
    mode: "tagged",
    tagPattern: "^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$",
    producer: { workflow: "release.yml", ref: "main", inputs: { channel: "stable" }, maxAttempts: 2 }
  };
  assert.equal(release.validateReleasePolicy(tagged).producer.workflow, "release.yml");
  assert.throws(() => release.validateReleasePolicy({ ...tagged, producer: null }), /requires an exact trusted workflow producer/);
});

test("required release checks fail closed on missing, red, or wrong-App evidence", () => {
  const protection = protectedBranch();
  const green = release.evaluateRequiredChecks(protection, checkRuns("success", 15368), { statuses: [] }, releasePolicy().requiredChecks);
  assert.equal(green.green, true);

  const red = release.evaluateRequiredChecks(protection, checkRuns("failure", 15368), { statuses: [] }, releasePolicy().requiredChecks);
  assert.equal(red.green, false);
  assert.ok(red.red.includes("DarkFactory Autoreview"));

  const spoofed = release.evaluateRequiredChecks(protection, checkRuns("success", 1234), { statuses: [] }, releasePolicy().requiredChecks);
  assert.equal(spoofed.green, false);
  assert.deepEqual(spoofed.red.sort(), ["DarkFactory Autoreview", "Validate"]);

  const externalProtection = structuredClone(protectedBranch());
  externalProtection.required_status_checks.checks.push({ context: "Security Scan", app_id: 999 });
  const externalRuns = checkRuns("success", 15368);
  externalRuns.check_runs.push({
    name: "Security Scan", status: "completed", conclusion: "success", app: { id: 999 }
  });
  const externalGreen = release.evaluateRequiredChecks(
    externalProtection, externalRuns, { statuses: [] }, releasePolicy().requiredChecks
  );
  assert.equal(externalGreen.green, true);

  const expectedExternalRun = externalRuns.check_runs.at(-1);
  assert.ok(expectedExternalRun);
  const wrongExternalRun = structuredClone(expectedExternalRun);
  wrongExternalRun.app.id = 998;
  for (const collision of [
    [wrongExternalRun, expectedExternalRun],
    [expectedExternalRun, wrongExternalRun]
  ]) {
    const collisionRuns = checkRuns("success", 15368);
    collisionRuns.check_runs.push(...structuredClone(collision));
    const collisionGreen = release.evaluateRequiredChecks(
      externalProtection, collisionRuns, { statuses: [] }, releasePolicy().requiredChecks
    );
    assert.equal(collisionGreen.green, true);
  }

  for (const result of [
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: "" }
  ]) {
    const conflictingExternalRun = structuredClone(expectedExternalRun);
    conflictingExternalRun.status = result.status;
    conflictingExternalRun.conclusion = result.conclusion;
    for (const collision of [
      [conflictingExternalRun, expectedExternalRun],
      [expectedExternalRun, conflictingExternalRun]
    ]) {
      const collisionRuns = checkRuns("success", 15368);
      collisionRuns.check_runs.push(...structuredClone(collision));
      const collisionRed = release.evaluateRequiredChecks(
        externalProtection, collisionRuns, { statuses: [] }, releasePolicy().requiredChecks
      );
      assert.equal(collisionRed.green, false);
      assert.deepEqual(collisionRed.red, ["Security Scan"]);
    }
  }

  const mismatchedExternalRuns = checkRuns("success", 15368);
  mismatchedExternalRuns.check_runs.push(wrongExternalRun);
  const externalMismatch = release.evaluateRequiredChecks(
    externalProtection, mismatchedExternalRuns, { statuses: [] }, releasePolicy().requiredChecks
  );
  assert.equal(externalMismatch.green, false);
  assert.deepEqual(externalMismatch.red, ["Security Scan"]);
});

test("main evidence evaluates only policy-selected checks despite broader protection", () => {
  const observed = {
    check_runs: [
      { name: "Validate", status: "completed", conclusion: "success", app: { id: 15368 } }
    ]
  };
  const protectedPull = release.evaluateRequiredChecks(
    protectedBranch(), observed, { statuses: [] }, releasePolicy().mainChecks
  );
  assert.equal(protectedPull.green, false);
  assert.deepEqual(protectedPull.missing, ["DarkFactory Autoreview"]);

  const validateOnly = release.evaluatePolicySelectedChecks(
    observed,
    { statuses: [] },
    releasePolicy().mainChecks
  );
  assert.equal(validateOnly.green, true);
  assert.deepEqual(validateOnly.checks, [{
    name: "Validate",
    expectedAppId: 15368,
    actualAppId: 15368,
    id: null,
    url: null,
    state: "green"
  }]);
  assert.deepEqual(validateOnly.missing, []);
});

test("release check evidence is complete and bound to the exact trusted workflow", async () => {
  const workflowPaths = new Map([
    [900, ".github/workflows/ci.yml"],
    [901, ".github/workflows/untrusted.yml"]
  ]);
  const finalCheck = {
    id: 500, name: "Validate", head_sha: SHA.main, status: "completed", conclusion: "success",
    app: { id: 15368 }, check_suite: { id: 900 }
  };
  const gh = {
    request: async (_method: string, path: string) => {
      if (path.includes("/check-suites?")) {
        assert.match(path, /[?&]filter=all(?:&|$)/);
        return {
          total_count: 1,
          check_suites: [{
            id: 900, head_sha: SHA.main, app: { id: 15368 }, status: "completed", conclusion: "success",
            latest_check_runs_count: 101
          }]
        };
      }
      if (path.includes("/check-suites/900/check-runs?") && path.endsWith("page=1")) {
        return {
          total_count: 101,
          check_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1, name: `Other ${index}`, head_sha: SHA.main,
            status: "completed", conclusion: "success", app: { id: 15368 }, check_suite: { id: 900 }
          }))
        };
      }
      if (path.includes("/check-suites/900/check-runs?") && path.endsWith("page=2")) {
        return { total_count: 101, check_runs: [finalCheck] };
      }
      if (path.includes("/actions/runs?check_suite_id=")) {
        const suiteId = Number(path.match(/check_suite_id=(\d+)/)?.[1]);
        return { total_count: 1, workflow_runs: [{
          id: suiteId + 700, check_suite_id: suiteId, head_sha: SHA.main, path: workflowPaths.get(suiteId),
          event: "push", head_branch: "main",
          repository: { id: 42, full_name: "marius-patrik/example" },
          head_repository: { id: 42, full_name: "marius-patrik/example" },
          pull_requests: [], status: "completed", conclusion: "success", run_attempt: 1
        }] };
      }
      if (path.includes("/status?") && path.endsWith("page=1")) {
        return {
          sha: SHA.main,
          total_count: 101,
          statuses: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1, context: `Legacy ${index}`, state: "success"
          }))
        };
      }
      if (path.includes("/status?") && path.endsWith("page=2")) {
        return { sha: SHA.main, total_count: 101, statuses: [{ id: 101, context: "Security Scan", state: "success" }] };
      }
      throw new Error(`unexpected mocked request: ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const complete = await release.listCompleteCheckRuns(repo(), SHA.main);
  assert.equal(complete.check_runs.length, 101);
  const statuses = await release.listCompleteCommitStatuses(repo(), SHA.main);
  assert.equal(statuses.statuses.length, 101);
  const trusted = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, complete, ["Validate"], { expectedBranch: "main" }
  );
  assert.equal(trusted.check_runs.find((run: any) => run.id === finalCheck.id)?._trustedPolicyWorkflow, true);

  const trustedFinal = trusted.check_runs.find((run: any) => run.id === finalCheck.id);
  const spoof = {
    ...trustedFinal,
    id: 501,
    check_suite: { id: 901 },
    _checkSuiteEvidence: {
      id: 901, appId: 15368, status: "completed", conclusion: "success",
      latestCheckRunsCount: 1, enumeratedCheckRunsCount: 1
    }
  };
  const collision = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 2, check_runs: [trustedFinal, spoof] }, ["Validate"], { expectedBranch: "main" }
  );
  assert.equal(collision.check_runs.length, 2);
  const rejected = release.evaluatePolicySelectedChecks(collision, { statuses: [] }, ["Validate"]);
  assert.deepEqual(rejected.red, ["Validate"]);

  const wrongBranch = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 1, check_runs: [trustedFinal] }, ["Validate"], { expectedBranch: "dev" }
  );
  assert.equal(wrongBranch.check_runs[0]._trustedPolicyWorkflow, false);
  assert.deepEqual(release.evaluatePolicySelectedChecks(wrongBranch, { statuses: [] }, ["Validate"]).red, ["Validate"]);

  const custom = { ...finalCheck, id: 502, name: "Artifact Scan", check_suite: { id: 902 } };
  const additional = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 1, check_runs: [custom] }, ["Artifact Scan"]
  );
  assert.equal(additional.check_runs[0].id, custom.id);
  assert.equal(additional.check_runs[0]._trustedPolicyWorkflow, false);
  assert.deepEqual(
    release.evaluatePolicySelectedChecks(additional, { statuses: [] }, ["Artifact Scan"]).red,
    ["Artifact Scan"]
  );
});

test("release evidence inventories reject changing, duplicate, malformed, truncated, and oversized pages", async () => {
  const item = (kind: "checks" | "statuses", id: number) => kind === "checks"
    ? { id, name: `Check ${id}`, head_sha: SHA.main, app: { id: 15368 }, check_suite: { id: 800 } }
    : { id, context: `Status ${id}` };
  const completePage = (kind: "checks" | "statuses") => Array.from({ length: 100 }, (_, index) => kind === "checks"
    ? item(kind, index + 1)
    : item(kind, index + 1));
  const cases = [
    {
      name: "changing total",
      response: (kind: "checks" | "statuses", page: number) => page === 1
        ? { total_count: 101, [kind === "checks" ? "check_runs" : "statuses"]: completePage(kind) }
        : { total_count: 102, [kind === "checks" ? "check_runs" : "statuses"]: [item(kind, 101)] }
    },
    {
      name: "duplicate id",
      response: (kind: "checks" | "statuses", page: number) => page === 1
        ? { total_count: 101, [kind === "checks" ? "check_runs" : "statuses"]: completePage(kind) }
        : { total_count: 101, [kind === "checks" ? "check_runs" : "statuses"]: [item(kind, 100)] }
    },
    {
      name: "malformed id",
      response: (kind: "checks" | "statuses") => ({
        total_count: 1, [kind === "checks" ? "check_runs" : "statuses"]: [item(kind, 0)]
      })
    },
    {
      name: "truncated page",
      response: (kind: "checks" | "statuses") => ({
        total_count: 101,
        [kind === "checks" ? "check_runs" : "statuses"]: completePage(kind).slice(0, 99)
      })
    },
    {
      name: "oversized inventory",
      response: (kind: "checks" | "statuses") => ({
        total_count: 2001, [kind === "checks" ? "check_runs" : "statuses"]: []
      })
    }
  ];
  for (const kind of ["checks", "statuses"] as const) {
    for (const scenario of cases) {
      const gh = {
        request: async (_method: string, path: string) => {
          const page = Number(path.match(/page=(\d+)/)?.[1]);
          if (kind === "checks" && path.includes("/check-suites?")) {
            return {
              total_count: 1,
              check_suites: [{ id: 800, head_sha: SHA.main, app: { id: 15368 } }]
            };
          }
          const response = scenario.response(kind, page);
          return kind === "statuses" ? { sha: SHA.main, ...response } : response;
        }
      };
      release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
      const operation = kind === "checks"
        ? release.listCompleteCheckRuns(repo(), SHA.main)
        : release.listCompleteCommitStatuses(repo(), SHA.main);
      await assert.rejects(operation, /release (check-run|commit-status) inventory/, `${kind}: ${scenario.name}`);
    }
  }

  release.configureReleaseRuntime({
    gh: {
      request: async () => ({
        total_count: 101,
        check_suites: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1, head_sha: SHA.main, app: { id: 15368 }
        }))
      })
    },
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" }
  });
  await assert.rejects(release.listCompleteCheckRuns(repo(), SHA.main), /check-suite inventory.*bounded limit/);

  for (const badSha of [undefined, SHA.dev]) {
    release.configureReleaseRuntime({
      gh: {
        request: async () => ({
          ...(badSha ? { sha: badSha } : {}), total_count: 0, statuses: []
        })
      },
      controlRepo: { owner: "marius-patrik", repo: "DarkFactory" }
    });
    await assert.rejects(
      release.listCompleteCommitStatuses(repo(), SHA.main),
      /commit-status inventory is malformed/,
      badSha ? "mismatched status sha" : "missing status sha"
    );
  }
});

test("release inventories reject same-count evidence mutation between consistency passes", async () => {
  let checkRunReads = 0;
  let statusReads = 0;
  const gh = {
    request: async (_method: string, path: string) => {
      if (path.includes("/check-suites?")) {
        return { total_count: 1, check_suites: [{ id: 800, head_sha: SHA.main, app: { id: 15368 } }] };
      }
      if (path.includes("/check-suites/800/check-runs?")) {
        checkRunReads += 1;
        return {
          total_count: 1,
          check_runs: [{
            id: 801, name: "Validate", head_sha: SHA.main, app: { id: 15368 }, check_suite: { id: 800 },
            status: "completed", conclusion: checkRunReads === 1 ? "success" : "failure"
          }]
        };
      }
      if (path.includes("/status?")) {
        statusReads += 1;
        return {
          sha: SHA.main,
          total_count: 1,
          statuses: [{ id: 901, context: "Legacy", state: statusReads === 1 ? "success" : "failure" }]
        };
      }
      throw new Error(`unexpected mocked request: ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  await assert.rejects(release.listCompleteCheckRuns(repo(), SHA.main), /changed during verification/);
  await assert.rejects(release.listCompleteCommitStatuses(repo(), SHA.main), /changed during verification/);
});

test("standard policy gates require exact and unambiguous workflow provenance", async () => {
  const checks = [
    {
      id: 601, name: "Validate", head_sha: SHA.main, status: "completed", conclusion: "success",
      app: { id: 15368 }, check_suite: { id: 910 },
      _checkSuiteEvidence: {
        id: 910, appId: 15368, status: "completed", conclusion: "success",
        latestCheckRunsCount: 1, enumeratedCheckRunsCount: 1
      }
    },
    {
      id: 602, name: "DarkFactory Autoreview", head_sha: SHA.main, status: "completed", conclusion: "success",
      app: { id: 15368 }, check_suite: { id: 911 },
      _checkSuiteEvidence: {
        id: 911, appId: 15368, status: "completed", conclusion: "success",
        latestCheckRunsCount: 1, enumeratedCheckRunsCount: 1
      }
    }
  ];
  const workflowRun = (suiteId: number) => ({
    id: suiteId + 1000,
    check_suite_id: suiteId,
    head_sha: SHA.main,
    path: `${suiteId === 911 ? ".github/workflows/darkfactory-autoreview.yml" : ".github/workflows/ci.yml"}@main`,
    event: suiteId === 911 ? "pull_request_target" : "pull_request",
    head_branch: "feature",
    repository: { id: 42, full_name: "marius-patrik/example" },
    head_repository: { id: 42, full_name: "marius-patrik/example" },
    pull_requests: [{
      number: 7,
      head: { ref: "feature", sha: SHA.main, repo: { id: 42 } },
      base: { ref: "main", sha: SHA.dev, repo: { id: 42 } }
    }],
    status: "completed",
    conclusion: "success",
    run_attempt: 1
  });
  const bindingOptions = {
    expectedPull: {
      number: 7, headRef: "feature", headSha: SHA.main, baseRef: "main", baseSha: SHA.dev
    }
  };
  let runs = new Map<number, any[]>([
    [910, [workflowRun(910)]],
    [911, [workflowRun(911)]]
  ]);
  const gh = {
    request: async (_method: string, path: string) => {
      const suiteId = Number(path.match(/check_suite_id=(\d+)/)?.[1]);
      const workflowRuns = runs.get(suiteId) ?? [];
      return { total_count: workflowRuns.length, workflow_runs: workflowRuns };
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const valid = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 2, check_runs: checks }, checks.map((check) => check.name), bindingOptions
  );
  assert.ok(valid.check_runs.every((run: any) => run._trustedPolicyWorkflow === true));
  assert.equal(release.evaluatePolicySelectedChecks(valid, { statuses: [] }, checks.map((check) => check.name)).green, true);

  const invalidRuns = [
    { name: "wrong path", run: { ...workflowRun(910), path: ".github/workflows/untrusted.yml" } },
    { name: "wrong ref", run: { ...workflowRun(910), path: ".github/workflows/ci.yml@feature" } },
    { name: "wrong event", run: { ...workflowRun(910), event: "issues" } },
    { name: "wrong repository", run: { ...workflowRun(910), head_repository: { id: 43, full_name: "attacker/example" } } },
    { name: "wrong head", run: { ...workflowRun(910), head_sha: SHA.dev } },
    { name: "wrong suite", run: { ...workflowRun(910), check_suite_id: 999 } },
    { name: "wrong state", run: { ...workflowRun(910), status: "in_progress", conclusion: null } },
    { name: "wrong conclusion", run: { ...workflowRun(910), conclusion: "failure" } },
    {
      name: "dispatch cannot gate a pull",
      run: { ...workflowRun(910), event: "workflow_dispatch", head_branch: "main", pull_requests: [] }
    },
    {
      name: "same head wrong pull",
      run: { ...workflowRun(910), pull_requests: [{ ...workflowRun(910).pull_requests[0], number: 8 }] }
    },
    {
      name: "same head wrong base",
      run: {
        ...workflowRun(910),
        pull_requests: [{
          ...workflowRun(910).pull_requests[0],
          base: { ...workflowRun(910).pull_requests[0].base, ref: "dev", sha: SHA.merge }
        }]
      }
    }
  ];
  for (const scenario of invalidRuns) {
    runs = new Map([[910, [scenario.run]]]);
    const bound = await release.bindTrustedPolicyCheckRuns(
      repo(), SHA.main, { total_count: 1, check_runs: [checks[0]] }, ["Validate"], bindingOptions
    );
    assert.equal(bound.check_runs[0]._trustedPolicyWorkflow, false, scenario.name);
    assert.deepEqual(
      release.evaluatePolicySelectedChecks(bound, { statuses: [] }, ["Validate"]).red,
      ["Validate"],
      scenario.name
    );
  }

  runs = new Map([[910, [workflowRun(910)]]]);
  const invalidSuites = [
    { name: "suite wrong app", evidence: { ...checks[0]._checkSuiteEvidence, appId: 1 } },
    { name: "suite wrong state", evidence: { ...checks[0]._checkSuiteEvidence, status: "in_progress", conclusion: null } },
    { name: "suite wrong conclusion", evidence: { ...checks[0]._checkSuiteEvidence, conclusion: "failure" } },
    { name: "suite count mismatch", evidence: { ...checks[0]._checkSuiteEvidence, latestCheckRunsCount: 2 } }
  ];
  for (const scenario of invalidSuites) {
    const check = { ...checks[0], _checkSuiteEvidence: scenario.evidence };
    const bound = await release.bindTrustedPolicyCheckRuns(
      repo(), SHA.main, { total_count: 1, check_runs: [check] }, ["Validate"], bindingOptions
    );
    assert.equal(bound.check_runs[0]._trustedPolicyWorkflow, false, scenario.name);
    assert.deepEqual(
      release.evaluatePolicySelectedChecks(bound, { statuses: [] }, ["Validate"]).red,
      ["Validate"],
      scenario.name
    );
  }

  runs = new Map([[910, [workflowRun(910), { ...workflowRun(910), id: 1911, path: ".github/workflows/untrusted.yml@main" }]]]);
  const ambiguous = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 1, check_runs: [checks[0]] }, ["Validate"], bindingOptions
  );
  assert.equal(ambiguous.check_runs[0]._trustedPolicyWorkflow, false);
  assert.deepEqual(release.evaluatePolicySelectedChecks(ambiguous, { statuses: [] }, ["Validate"]).red, ["Validate"]);

  let baseWorkflowSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const unqualified = { ...workflowRun(910), path: ".github/workflows/ci.yml" };
  release.configureReleaseRuntime({
    gh: {
      request: async (_method: string, path: string) => {
        if (path.includes("/actions/runs?")) return { total_count: 1, workflow_runs: [unqualified] };
        if (path.includes("/contents/.github/workflows/ci.yml?")) {
          return {
            type: "file",
            sha: path.includes(encodeURIComponent(SHA.main))
              ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              : baseWorkflowSha
          };
        }
        throw new Error(`unexpected mocked request: ${path}`);
      }
    },
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" }
  });
  const sameDefinition = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 1, check_runs: [checks[0]] }, ["Validate"], bindingOptions
  );
  assert.equal(sameDefinition.check_runs[0]._trustedPolicyWorkflow, true);
  baseWorkflowSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const headControlled = await release.bindTrustedPolicyCheckRuns(
    repo(), SHA.main, { total_count: 1, check_runs: [checks[0]] }, ["Validate"], bindingOptions
  );
  assert.equal(headControlled.check_runs[0]._trustedPolicyWorkflow, false);

  let workflowReads = 0;
  release.configureReleaseRuntime({
    gh: {
      request: async () => {
        workflowReads += 1;
        return {
          total_count: 1,
          workflow_runs: [{
            ...workflowRun(910),
            conclusion: workflowReads === 1 ? "success" : "failure"
          }]
        };
      }
    },
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" }
  });
  await assert.rejects(
    release.bindTrustedPolicyCheckRuns(
      repo(), SHA.main, { total_count: 1, check_runs: [checks[0]] }, ["Validate"], bindingOptions
    ),
    /workflow-run binding changed during verification/
  );
});

test("release plans are deterministic for identical, ahead, diverged, and blocked evidence", () => {
  const base = { repository: "marius-patrik/example", mainSha: SHA.main, devSha: SHA.dev, policy: releasePolicy() };
  assert.equal(release.buildReleasePlan({ ...base, classification: "identical" }).action, "verify");
  assert.equal(release.buildReleasePlan({ ...base, classification: "tree-identical" }).action, "verify");
  assert.equal(release.buildReleasePlan({ ...base, classification: "dev-ahead" }).action, "release");
  assert.equal(release.buildReleasePlan({ ...base, classification: "main-ahead" }).action, "reconcile-fast-forward");
  assert.equal(release.buildReleasePlan({ ...base, classification: "diverged" }).action, "reconcile-merge");
  assert.equal(release.buildReleasePlan({ ...base, classification: "missing-dev" }).action, "owner-required");
  assert.equal(
    release.buildReleasePlan({ ...base, classification: "dev-ahead" }).planId,
    release.buildReleasePlan({ ...base, classification: "dev-ahead" }).planId
  );
});

test("release closure planning rejects truncated comparison history", async () => {
  const gh = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path.includes("/compare/")) return { total_commits: 251, commits: [] };
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  await assert.rejects(release.releaseClosurePlan(repo(), SHA.main, SHA.dev), /history is truncated/);
});

test("release closure planning paginates commit-associated pull requests", async () => {
  const gh = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path.includes("/compare/")) {
        return { total_commits: 1, commits: [{ sha: SHA.merge, commit: { message: "implementation" } }] };
      }
      if (method === "GET" && path.includes(`/commits/${SHA.merge}/pulls`) && /[?&]page=1$/.test(path)) {
        return Array.from({ length: 100 }, () => ({ body: "no closing reference" }));
      }
      if (method === "GET" && path.includes(`/commits/${SHA.merge}/pulls`) && /[?&]page=2$/.test(path)) {
        return [{ body: "Closes #77" }];
      }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  assert.deepEqual(await release.releaseClosurePlan(repo(), SHA.main, SHA.dev), [77]);
});

test("green dev-ahead release creates one marker-owned branch/PR and arms automerge idempotently", async () => {
  const refs = new Map([["main", SHA.main], ["dev", SHA.dev]]);
  const pulls: any[] = [];
  const mutations: string[] = [];
  let graphqlCalls = 0;
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = refs.get(branch);
        if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
        return { object: { sha } };
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "POST" && path.endsWith("/git/refs")) {
        const branch = String(body.ref).replace("refs/heads/", "");
        refs.set(branch, body.sha);
        mutations.push(`branch:${branch}`);
        return { ref: body.ref, object: { sha: body.sha } };
      }
      if (method === "GET" && path.includes("/compare/")) return { status: "ahead", ahead_by: 1, behind_by: 0, commits: [] };
      if (method === "GET" && path.includes("/pulls?state=open&base=main")) return pulls;
      if (method === "POST" && path.endsWith("/pulls")) {
        const pull = trustedPull({ number: 7, branch: body.head, base: body.base, headSha: SHA.dev, title: body.title, body: body.body });
        pulls.push(pull);
        mutations.push("pull:7");
        return pull;
      }
      if (method === "GET" && path.endsWith("/pulls/7")) return pulls[0];
      if (method === "GET" && path.includes("/actions/runs?check_suite_id=")) {
        return workflowRuns(path, SHA.dev, "success", {
          number: 7, headRef: `release/${SHA.dev.slice(0, 12)}`, baseRef: "main", baseSha: SHA.main
        });
      }
      if (method === "GET" && path.includes("/check-suites?")) return checkSuites(SHA.dev);
      if (method === "GET" && path.includes("/check-suites/") && path.includes("/check-runs?")) {
        return suiteCheckRuns(path, "success", 15368, SHA.dev);
      }
      if (method === "GET" && path.includes("/status?")) return { sha: SHA.dev, total_count: 0, statuses: [] };
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    },
    graphql: async () => {
      graphqlCalls += 1;
      pulls[0].auto_merge = { enabled_at: "2026-07-15T00:00:00Z" };
      return { enablePullRequestAutoMerge: { pullRequest: { url: pulls[0].html_url } } };
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("dev-ahead");
  const plan = release.buildReleasePlan(observation);

  const first = await release.ensureReleasePull(repo(), observation, plan);
  const second = await release.ensureReleasePull(repo(), observation, plan);

  assert.equal(first.status, "automerge-armed");
  assert.equal(second.status, "automerge-armed");
  assert.equal(graphqlCalls, 1);
  assert.deepEqual(mutations, ["branch:release/222222222222", "pull:7"]);
  assert.match(pulls[0].body, /darkfactory:release-issues/);
});

test("diverged reconciliation escalates exact comparison hunks and never guesses a conflict", async () => {
  const refs = new Map([["main", SHA.main], ["dev", SHA.dev]]);
  const writes: Array<{ method: string; path: string; body?: any }> = [];
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = refs.get(branch);
        if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
        return { object: { sha } };
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "POST" && path.endsWith("/git/refs")) {
        refs.set(String(body.ref).replace("refs/heads/", ""), body.sha);
        return {};
      }
      if (method === "POST" && path.endsWith("/merges")) throw Object.assign(new Error("conflict"), { status: 409 });
      if (method === "GET" && path.includes("/issues?state=open")) return [];
      if (method === "POST" && path.endsWith("/issues")) {
        writes.push({ method, path, body });
        return { number: 99, html_url: "https://github.com/marius-patrik/example/issues/99" };
      }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = {
    ...releaseObservation("diverged"),
    comparison: { status: "diverged", ahead_by: 1, behind_by: 1, files: [{ filename: "policy.json", patch: "@@ -1 +1 @@\n-old\n+new" }] }
  };
  const result = await release.reconcile(repo(), observation, release.buildReleasePlan(observation));

  assert.equal(result.status, "owner-required");
  assert.equal(writes.length, 1);
  assert.match(writes[0].body.body, /@@ -1 \+1 @@/);
  assert.match(writes[0].body.body, /will not guess a semantic resolution/);
  assert.deepEqual(writes[0].body.labels, ["P0", "df:ask-owner"]);
});

test("generated-only merge conflicts queue a reviewed mechanical repair without readiness bypass", async () => {
  const refs = new Map([["main", SHA.main], ["dev", SHA.dev]]);
  let created: any = null;
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = refs.get(branch);
        if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
        return { object: { sha } };
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "POST" && path.endsWith("/git/refs")) { refs.set(String(body.ref).replace("refs/heads/", ""), body.sha); return {}; }
      if (method === "POST" && path.endsWith("/merges")) throw Object.assign(new Error("conflict"), { status: 409 });
      if (method === "GET" && path.includes("/issues?state=open")) return [];
      if (method === "POST" && path.endsWith("/issues")) { created = body; return { number: 12, html_url: "https://example.test/12" }; }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = {
    ...releaseObservation("diverged"),
    comparison: { status: "diverged", ahead_by: 1, behind_by: 1, files: [{ filename: "package-lock.json", patch: "@@" }] }
  };
  const result = await release.reconcile(repo(), observation, release.buildReleasePlan(observation));
  assert.equal(result.status, "queued-for-readiness");
  assert.deepEqual(created.labels, ["P0", "df:class:mechanical"]);
  assert.equal(created.labels.includes("df:ready"), false);
});

test("main-ahead reconciliation uses one reviewed PR and never writes dev directly", async () => {
  const branch = `reconcile/${SHA.main.slice(0, 8)}-${SHA.dev.slice(0, 8)}`;
  const refs = new Map([["main", SHA.main], ["dev", SHA.dev]]);
  const writes: Array<{ method: string; path: string; body?: any }> = [];
  let pull: any = null;
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const name = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = refs.get(name);
        if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
        return { object: { sha } };
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "POST" && path.endsWith("/git/refs")) {
        refs.set(String(body.ref).replace("refs/heads/", ""), body.sha);
        writes.push({ method, path, body });
        return { ref: body.ref, object: { sha: body.sha } };
      }
      if (method === "GET" && path.includes("/pulls?state=open&base=dev")) return pull ? [pull] : [];
      if (method === "POST" && path.endsWith("/pulls")) {
        pull = trustedPull({ number: 8, branch: body.head, base: body.base, headSha: SHA.main, title: body.title, body: body.body });
        writes.push({ method, path, body });
        return pull;
      }
      if (method === "GET" && path.endsWith("/pulls/8")) return pull;
      if (method === "GET" && path.includes("/actions/runs?check_suite_id=")) {
        return workflowRuns(path, SHA.main, "success", {
          number: 8, headRef: branch, baseRef: "dev", baseSha: SHA.dev
        });
      }
      if (method === "GET" && path.includes("/check-suites?")) return checkSuites(SHA.main);
      if (method === "GET" && path.includes("/check-suites/") && path.includes("/check-runs?")) {
        return suiteCheckRuns(path, "success", 15368, SHA.main);
      }
      if (method === "GET" && path.includes("/status?")) return { sha: SHA.main, total_count: 0, statuses: [] };
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    },
    graphql: async () => ({ enablePullRequestAutoMerge: { pullRequest: { url: pull.html_url } } })
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("main-ahead");
  const result = await release.reconcile(repo(), observation, release.buildReleasePlan(observation));
  assert.equal(result.status, "automerge-armed");
  assert.equal(pull.head.ref, branch);
  assert.equal(pull.base.ref, "dev");
  assert.deepEqual(writes.map((write) => `${write.method} ${write.path.split("/repos/marius-patrik/example")[1]}`), [
    "POST /git/refs",
    "POST /pulls"
  ]);
  assert.ok(writes.every((write) => write.body?.ref !== "refs/heads/dev"));
});

test("deleted dev recovery fails closed on the same explicit owner contract", async () => {
  const writes: any[] = [];
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/issues?state=open")) return [];
      if (method === "POST" && path.endsWith("/issues")) {
        writes.push({ method, path, body });
        return { user: { login: "darkfactory-agent[bot]", type: "Bot" }, number: 13, html_url: "https://github.com/marius-patrik/example/issues/13" };
      }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("missing-dev", { devSha: null });
  const result = await release.reconcile(repo(), observation, release.buildReleasePlan(observation));
  assert.equal(result.status, "owner-required");
  assert.equal(writes.length, 1);
  assert.match(writes[0].body.body, /Dev: `missing`/);
  assert.ok(!String(writes[0].path).includes("git/refs"));
});

test("diverged reconciliation resumes from the exact trusted two-parent merge", async () => {
  const branch = "reconcile/11111111-22222222";
  const refs = new Map([["main", SHA.main], ["dev", SHA.dev], [branch, SHA.merge]]);
  let pull: any = null;
  let mergeCalls = 0;
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const name = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = refs.get(name);
        if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
        return { object: { sha } };
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "GET" && path.endsWith(`/commits/${SHA.merge}`)) {
        return {
          sha: SHA.merge,
          parents: [{ sha: SHA.dev }, { sha: SHA.main }],
          author: { login: "darkfactory-agent[bot]", type: "Bot" },
          committer: { login: "web-flow", type: "User" },
          commit: { message: `Reconcile main ${SHA.main.slice(0, 12)} into dev ${SHA.dev.slice(0, 12)}` }
        };
      }
      if (method === "POST" && path.endsWith("/merges")) { mergeCalls += 1; return {}; }
      if (method === "GET" && path.includes("/pulls?state=open&base=dev")) return pull ? [pull] : [];
      if (method === "POST" && path.endsWith("/pulls")) {
        pull = trustedPull({ number: 9, branch: body.head, base: body.base, headSha: SHA.merge, title: body.title, body: body.body });
        return pull;
      }
      if (method === "GET" && path.endsWith("/pulls/9")) return pull;
      if (method === "GET" && path.includes("/actions/runs?check_suite_id=")) {
        return workflowRuns(path, SHA.merge, "success", {
          number: 9, headRef: branch, baseRef: "dev", baseSha: SHA.dev
        });
      }
      if (method === "GET" && path.includes("/check-suites?")) return checkSuites(SHA.merge);
      if (method === "GET" && path.includes("/check-suites/") && path.includes("/check-runs?")) {
        return suiteCheckRuns(path, "success", 15368, SHA.merge);
      }
      if (method === "GET" && path.includes("/status?")) return { sha: SHA.merge, total_count: 0, statuses: [] };
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    },
    graphql: async () => ({ enablePullRequestAutoMerge: { pullRequest: { url: pull.html_url } } })
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = { ...releaseObservation("diverged"), comparison: { status: "diverged", ahead_by: 1, behind_by: 1, files: [] } };
  const result = await release.reconcile(repo(), observation, release.buildReleasePlan(observation));

  assert.equal(result.status, "automerge-armed");
  assert.equal(mergeCalls, 0);
  assert.match(pull.body, new RegExp(`head=${SHA.merge}`));
});

test("release cleanup trusts only App markers and relies on atomic delete-on-merge", async () => {
  const trusted = {
    ...trustedPull({
      number: 10,
      branch: `release/${SHA.dev.slice(0, 12)}`,
      base: "main",
      headSha: SHA.dev,
      body: `<!-- darkfactory:release plan=release-aaaaaaaaaaaaaaaaaaaa main=${SHA.main} dev=${SHA.dev} -->`
    }),
    merged: true,
    merged_at: "2026-07-15T00:00:00Z",
    state: "closed"
  };
  const human = {
    ...trustedPull({ number: 11, branch: "release/human", base: "main", headSha: SHA.merge, body: "human release" }),
    user: { login: "human" }, merged: true, merged_at: "2026-07-15T00:00:00Z", state: "closed"
  };
  const mutations: string[] = [];
  const gh = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path.includes("/pulls?state=closed")) return [trusted, human];
      if (method === "GET" && path.endsWith("/pulls/10")) return trusted;
      if (method === "GET" && path.endsWith("/pulls/11")) return human;
      if (method === "GET" && path.includes(`/git/ref/heads/${encodeURIComponent(trusted.head.ref)}`)) {
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      mutations.push(`${method} ${path}`);
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const absent = await release.cleanupMergedReleaseBranches(repo(), releaseObservation("identical", { devSha: SHA.main }));
  assert.deepEqual(absent, [trusted.head.ref]);
  assert.deepEqual(mutations, []);
});

test("red post-release main CI creates one exact evidence issue and blocks verification", async () => {
  const writes: any[] = [];
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) return { object: { sha: SHA.main } };
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "GET" && path.includes("/actions/runs?check_suite_id=")) return workflowRuns(path, SHA.main, "failure");
      if (method === "GET" && path.includes("/check-suites?")) return checkSuites(SHA.main, "failure", [201]);
      if (method === "GET" && path.includes("/check-suites/") && path.includes("/check-runs?")) {
        return { total_count: 1, check_runs: [{ id: 77, name: "Validate", head_sha: SHA.main, html_url: "https://example.test/check/77", status: "completed", conclusion: "failure", app: { id: 15368 }, check_suite: { id: 201 } }] };
      }
      if (method === "GET" && path.includes("/status?")) return { sha: SHA.main, total_count: 0, statuses: [] };
      if (method === "GET" && path.includes("/issues?state=open")) return [];
      if (method === "POST" && path.endsWith("/issues")) {
        writes.push(body);
        return { number: 5, html_url: "https://github.com/marius-patrik/example/issues/5" };
      }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("identical", { devSha: SHA.main });
  const result = await release.verifyRelease(repo(), observation, release.buildReleasePlan(observation));
  assert.equal(result.verified, false);
  assert.equal(result.reason, "main-checks-not-green");
  assert.equal(writes.length, 1);
  assert.match(writes[0].body, new RegExp(SHA.main));
  assert.match(writes[0].body, /https:\/\/example\.test\/check\/77/);
  assert.deepEqual(writes[0].labels, ["P0", "df:class:standard"]);
});

test("green release verification proves the trusted PR and atomic cleanup evidence", async () => {
  const releaseBranch = `release/${SHA.dev.slice(0, 12)}`;
  let checkSha = SHA.main;
  const pull = {
    ...trustedPull({
      number: 12,
      branch: releaseBranch,
      base: "main",
      headSha: SHA.dev,
      body: `<!-- darkfactory:release plan=release-bbbbbbbbbbbbbbbbbbbb main=${SHA.main} dev=${SHA.dev} -->\n<!-- darkfactory:release-issues  -->`
    }),
    state: "closed",
    merged: true,
    merged_at: "2026-07-15T00:00:00Z"
  };
  const gh = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        if (branch === "main" || branch === "dev") return { object: { sha: SHA.main } };
        if (branch === releaseBranch) throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (method === "GET" && path.endsWith("/protection")) return protectedBranch();
      if (method === "GET" && path.includes("/actions/runs?check_suite_id=")) {
        return workflowRuns(path, checkSha, "success", checkSha === SHA.dev ? {
          number: 12, headRef: releaseBranch, baseRef: "main", baseSha: SHA.main
        } : null);
      }
      if (method === "GET" && path.includes("/check-suites?")) {
        checkSha = path.includes(SHA.dev) ? SHA.dev : SHA.main;
        return checkSuites(checkSha);
      }
      if (method === "GET" && path.includes("/check-suites/") && path.includes("/check-runs?")) {
        return suiteCheckRuns(path, "success", 15368, checkSha);
      }
      if (method === "GET" && path.includes("/status?")) return { sha: checkSha, total_count: 0, statuses: [] };
      if (method === "GET" && path.includes("/pulls?state=closed")) return [pull];
      if (method === "GET" && path.endsWith("/pulls/12")) return pull;
      if (method === "GET" && path.includes("/compare/")) return { status: "ahead", ahead_by: 1, behind_by: 0 };
      if (method === "GET" && path.endsWith(`/git/commits/${SHA.dev}`)) return { tree: { sha: TREE.converged } };
      if (method === "GET" && path.includes("/issues?state=open")) return [];
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("identical", { devSha: SHA.main });
  const result = await release.verifyRelease(repo(), observation, release.buildReleasePlan(observation));
  assert.equal(result.verified, true);
  assert.equal(result.release.kind, "release");
  assert.equal(result.release.pull_request, pull.html_url);
  assert.deepEqual(result.verified_absent_automation_branches, [releaseBranch]);
});

test("release verification rejects unequal trees even when a caller labels state converged", async () => {
  release.configureReleaseRuntime({ gh: { request: async () => { throw new Error("must not read"); } }, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const observation = releaseObservation("tree-identical", { devTreeSha: TREE.different });
  await assert.rejects(
    release.verifyRelease(repo(), observation, release.buildReleasePlan(observation)),
    /requires exact commit or tree identity/
  );
});

test("tagged publication resolves an annotated tag to the exact released main", async () => {
  const gh = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path.endsWith("/git/matching-refs/tags/")) {
        return [{ ref: "refs/tags/v1.2.3", object: { type: "tag", sha: SHA.merge } }];
      }
      if (method === "GET" && path.endsWith(`/git/tags/${SHA.merge}`)) {
        return { object: { type: "commit", sha: SHA.main } };
      }
      throw new Error(`unexpected mocked request: ${method} ${path}`);
    }
  };
  release.configureReleaseRuntime({ gh, controlRepo: { owner: "marius-patrik", repo: "DarkFactory" } });
  const policy = {
    ...releasePolicy(),
    mode: "tagged",
    tagPattern: "^refs/tags/v1\\.2\\.3$",
    producer: { workflow: "release.yml", ref: "main", inputs: {}, maxAttempts: 2 }
  };
  const evidence = await release.verifyDeclaredPublication(repo(), { ...releaseObservation("identical", { devSha: SHA.main }), policy }, { checks: [] });
  assert.deepEqual(evidence, { green: true, mode: "tagged", tag: "refs/tags/v1.2.3" });
});

function repo() {
  return { owner: "marius-patrik", repo: "example" };
}

function releasePolicy() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "branch-only",
    releaseBranchPrefix: "release/",
    reconcileBranchPrefix: "reconcile/",
    requiredChecks: ["Validate", "DarkFactory Autoreview"],
    mainChecks: ["Validate"],
    tagPattern: null,
    artifactWorkflows: [],
    publicationChecks: [],
    producer: null
  };
}

function protectedBranch() {
  return {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "Validate", app_id: 15368 },
        { context: "DarkFactory Autoreview", app_id: 15368 }
      ]
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
}

function checkRuns(conclusion: string, appId: number, headSha = SHA.main): any {
  return {
    total_count: 2,
    check_runs: [
      { id: 101, name: "Validate", head_sha: headSha, status: "completed", conclusion, app: { id: appId }, check_suite: { id: 201 } },
      { id: 102, name: "DarkFactory Autoreview", head_sha: headSha, status: "completed", conclusion, app: { id: appId }, check_suite: { id: 202 } }
    ]
  };
}

function checkSuites(headSha = SHA.main, conclusion = "success", suiteIds = [201, 202]) {
  return {
    total_count: suiteIds.length,
    check_suites: suiteIds.map((id) => ({
      id,
      head_sha: headSha,
      app: { id: 15368 },
      status: "completed",
      conclusion,
      latest_check_runs_count: 1
    }))
  };
}

function suiteCheckRuns(path: string, conclusion: string, appId: number, headSha: string) {
  const suiteId = Number(path.match(/check-suites\/(\d+)\/check-runs/)?.[1]);
  const runs = checkRuns(conclusion, appId, headSha).check_runs.filter((run: any) => run.check_suite.id === suiteId);
  return { total_count: runs.length, check_runs: runs };
}

function workflowRuns(
  path: string,
  headSha: string,
  conclusion = "success",
  pullEvidence: { number: number; headRef: string; baseRef: string; baseSha: string } | null = null
) {
  const suiteId = Number(path.match(/check_suite_id=(\d+)/)?.[1]);
  const autoreview = suiteId === 202;
  return {
    total_count: 1,
    workflow_runs: [{
      id: suiteId + 1000,
      check_suite_id: suiteId,
      head_sha: headSha,
      path: `${autoreview ? ".github/workflows/darkfactory-autoreview.yml" : ".github/workflows/ci.yml"}@${pullEvidence?.baseRef ?? "main"}`,
      event: pullEvidence ? (autoreview ? "pull_request_target" : "pull_request") : (autoreview ? "workflow_dispatch" : "push"),
      head_branch: pullEvidence?.headRef ?? "main",
      repository: { id: 42, full_name: "marius-patrik/example" },
      head_repository: { id: 42, full_name: "marius-patrik/example" },
      pull_requests: pullEvidence ? [{
        number: pullEvidence.number,
        head: { ref: pullEvidence.headRef, sha: headSha, repo: { id: 42 } },
        base: { ref: pullEvidence.baseRef, sha: pullEvidence.baseSha, repo: { id: 42 } }
      }] : [],
      status: "completed",
      conclusion,
      run_attempt: 1
    }]
  };
}

function releaseObservation(classification: string, overrides: Record<string, unknown> = {}) {
  return {
    repository: "marius-patrik/example",
    metadata: { allow_auto_merge: true, delete_branch_on_merge: true, default_branch: "main" },
    policy: releasePolicy(),
    mainSha: SHA.main,
    devSha: SHA.dev,
    mainTreeSha: TREE.converged,
    devTreeSha: TREE.converged,
    classification,
    protections: {
      main: { configured: true, safe: true },
      dev: { configured: true, safe: true }
    },
    rawProtections: { main: protectedBranch(), dev: protectedBranch() },
    openPulls: [],
    ...overrides
  };
}

function trustedPull({ number, branch, base, headSha, title = "", body = "" }: any) {
  return {
    number,
    node_id: `PR_${number}`,
    state: "open",
    title,
    body,
    html_url: `https://github.com/marius-patrik/example/pull/${number}`,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: { ref: base },
    head: { ref: branch, sha: headSha, repo: { full_name: "marius-patrik/example" } },
    auto_merge: null
  };
}
