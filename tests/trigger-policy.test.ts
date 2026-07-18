import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { issueVersion } from "../src/issue-spec.ts";

// @ts-ignore Native ESM workflow policy is exercised directly.
const policyModule: any = await import("../.github/scripts/df-trigger-policy.mjs");
// @ts-ignore Trusted recovery controller is native ESM and exercised directly.
const recoveryModule: any = await import("../.github/scripts/df-autoreview-recovery.mjs?unit=trigger-policy-recovery-test");
// @ts-ignore Base-trusted Autoreview result classification is exercised directly.
const autoreviewRunner: any = await import("../.github/scripts/run-darkfactory-autoreview.mjs?unit=trigger-policy-result-test");
// @ts-ignore Shared native ESM GitHub transport is exercised against real response semantics.
const githubClientModule: any = await import("../.github/scripts/df-lib.mjs?unit=trigger-policy-github-client-test");
const {
  REQUIRED_LOOP_IDS,
  admitLoopInvocation,
  collectLoopWorkflowEvidence,
  loopStatusMarkdownRows,
  projectLoopStatus,
  readTriggerPolicy,
  renderLoopIdempotencyKey,
  validateTriggerPolicy
} = policyModule;
const root = path.resolve(import.meta.dirname, "..");

test("trigger policy covers every development loop with explicit cadence, admission, and authorization", async () => {
  const policy = await readTriggerPolicy(root);
  assert.equal(policy.policyVersion, "1.2.0");
  assert.deepEqual(policy.loops.map((loop: any) => loop.id).sort(), [...REQUIRED_LOOP_IDS].sort());
  for (const loop of policy.loops) {
    assert.match(loop.idempotencyKey, /\{repository\}.*\{target\}.*\{sourceVersion\}/);
    if (loop.recovery) assert.ok(loop.recovery.maxDetectionMinutes >= loop.recovery.intervalMinutes);
    assert.equal(loop.authorization.receiptRequired, true);
    assert.equal(loop.retry.escalationLabel, "df:ask-owner");
    if (loop.status === "active") {
      const workflow = await readFile(path.join(root, loop.recoveryWorkflow), "utf8");
      assert.ok(workflow.includes(`cron: "${loop.recovery.cron}"`), `${loop.id} schedule matches its active recovery workflow`);
      const eventSources = (await Promise.all(
        loop.eventWorkflows.map((workflowPath: string) => readFile(path.join(root, workflowPath), "utf8"))
      )).join("\n");
      for (const trigger of loop.eventTriggers) {
        assert.match(eventSources, new RegExp(`^\\s{2}${trigger.event}:`, "m"), `${loop.id} declares only live event triggers`);
      }
    }
  }
  const drafting = policy.loops.find((loop: any) => loop.id === "interactive-issue-drafting");
  assert.equal(drafting.status, "planned");
  assert.deepEqual(drafting.eventWorkflows, []);
  assert.equal(drafting.recoveryWorkflow, null);
  assert.deepEqual(drafting.eventTriggers, []);
  assert.equal(drafting.recovery, null);
  const hygiene = policy.loops.find((loop: any) => loop.id === "issue-draft-hygiene");
  assert.equal(hygiene.status, "active");
  assert.equal(hygiene.modelPolicy, "zero-token");
  assert.deepEqual(hygiene.authorization.permissions, ["contents:read"]);
});

test("issue draft hygiene is trusted-main, df-local, zero-token, sanitized, and package-owned", async () => {
  const [workflow, source, managed] = await Promise.all([
    readFile(path.join(root, ".github/workflows/df-issue-draft-hygiene.yml"), "utf8"),
    readFile(path.join(root, ".github/scripts/df-issue-draft-hygiene.mjs"), "utf8"),
    readFile(path.join(root, ".darkfactory/managed-repository.json"), "utf8")
  ]);
  assert.match(workflow, /cron: "19 \*\/6 \* \* \*"/);
  assert.match(workflow, /runs-on: \[self-hosted, df-local\]/);
  assert.match(workflow, /GITHUB_REF -ne "refs\/heads\/main"/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.doesNotMatch(`${workflow}\n${source}`, /agents run|modelTier|provider|DARK_FACTORY_PRIVATE_KEY/);
  assert.match(source, /modelTokens: 0/);
  assert.match(source, /sanitized: true/);
  const manifest = JSON.parse(managed);
  for (const required of [
    ".darkfactory/issue-draft-policy.json",
    ".github/workflows/df-issue-draft-hygiene.yml",
    ".github/scripts/df-issue-draft-hygiene.mjs"
  ]) {
    assert.ok(manifest.packageFiles.includes(required), `${required} is package-owned`);
    assert.ok(manifest.requiredFiles.includes(required), `${required} is required`);
  }
});

test("policy validation rejects unknown loops, stale latency, missing receipt admission, and non-independent model policy", async () => {
  const policy = await readTriggerPolicy(root);
  const extra = structuredClone(policy);
  extra.loops.push({ ...structuredClone(extra.loops[0]), id: "shadow-loop" });
  extra.loops.at(-1).idempotencyKey = "shadow-loop:{repository}:{target}:{sourceVersion}";
  assert.throws(() => validateTriggerPolicy(extra), /coverage mismatch/);

  const latency = structuredClone(policy);
  latency.loops[0].recovery.maxDetectionMinutes = latency.loops[0].recovery.intervalMinutes - 1;
  assert.throws(() => validateTriggerPolicy(latency), /must cover its schedule interval/);

  const receipt = structuredClone(policy);
  receipt.loops[0].authorization.receiptRequired = false;
  assert.throws(() => validateTriggerPolicy(receipt), /receipt admission/);

  const providerNamed = structuredClone(policy);
  providerNamed.loops[0].modelPolicy = "specific-provider";
  assert.throws(() => validateTriggerPolicy(providerNamed), /unknown model policy/);

  const fakeDraftWorkflow = structuredClone(policy);
  const drafting = fakeDraftWorkflow.loops.find((loop: any) => loop.id === "interactive-issue-drafting");
  drafting.eventWorkflows = [".github/workflows/df-issue-draft.yml"];
  drafting.recoveryWorkflow = ".github/workflows/df-issue-draft.yml";
  drafting.eventTriggers = [{ event: "schedule", types: [] }];
  drafting.recovery = { cron: "19 */6 * * *", intervalMinutes: 360, maxDetectionMinutes: 390 };
  assert.throws(() => validateTriggerPolicy(fakeDraftWorkflow), /explicitly local, human-driven/);
});

test("event and schedule recovery share one idempotency key while stale or untrusted events fail closed", async () => {
  const policy = await readTriggerPolicy(root);
  const context = {
    repository: "marius-patrik/DarkFactory",
    target: "issue-48",
    sourceVersion: "abc123",
    sourceRef: "refs/heads/main",
    deliveredAt: "2026-07-15T10:00:00.000Z"
  };
  const event = admitLoopInvocation(policy, "worker-dispatch", context, new Date("2026-07-15T10:05:00.000Z"));
  const recovered = renderLoopIdempotencyKey(policy, "worker-dispatch", context);
  assert.equal(event.idempotencyKey, recovered);

  assert.throws(
    () => admitLoopInvocation(policy, "worker-dispatch", { ...context, sourceRef: "refs/heads/dev" }, new Date("2026-07-15T10:05:00.000Z")),
    /trusted source ref/
  );
  assert.throws(
    () => admitLoopInvocation(policy, "worker-dispatch", context, new Date("2026-07-15T10:30:01.000Z")),
    /stale and must be replanned/
  );
  const submodule = admitLoopInvocation(
    policy,
    "submodule-autoupdate",
    { ...context, target: "plugins/DarkFactory" },
    new Date("2026-07-15T10:05:00.000Z")
  );
  assert.equal(submodule.loopId, "submodule-autoupdate");
  assert.match(submodule.idempotencyKey, /^submodule-autoupdate:/);
});

test("loop status projection exposes success, next run, source, retry, stale, and planned blockers", async () => {
  const policy = await readTriggerPolicy(root);
  const evidence: Record<string, any[]> = {};
  for (const loop of policy.loops.filter((entry: any) => entry.status === "active")) {
    evidence[loop.eventWorkflows[0]] = [{
      head_branch: "main",
      head_sha: "1234567890abcdef",
      created_at: "2026-07-15T09:50:00.000Z",
      updated_at: "2026-07-15T09:51:00.000Z",
      status: "completed",
      conclusion: "success",
      run_attempt: 1
    }];
  }
  evidence[".github/workflows/df-audit.yml"] = [{
    head_branch: "main",
    head_sha: "badbadbadbadbadb",
    created_at: "2026-07-13T09:00:00.000Z",
    updated_at: "2026-07-13T09:01:00.000Z",
    status: "completed",
    conclusion: "failure",
    run_attempt: 3
  }];
  const statuses = projectLoopStatus(policy, evidence, new Date("2026-07-15T10:00:00.000Z"));
  const doctor = statuses.find((entry: any) => entry.id === "repository-doctor");
  assert.equal(doctor.state, "stale");
  assert.equal(doctor.retry, "escalate:df:ask-owner");
  const worker = statuses.find((entry: any) => entry.id === "worker-dispatch");
  assert.equal(worker.state, "success");
  assert.equal(worker.source, "refs/heads/main@1234567890ab");
  assert.match(worker.nextExpected, /^2026-07-15T10:01:00/);
  const submodules = statuses.find((entry: any) => entry.id === "submodule-autoupdate");
  assert.equal(submodules.state, "success");
  assert.equal(submodules.retry, "idle");
  const markdown = loopStatusMarkdownRows(statuses);
  assert.match(markdown, /worker-dispatch/);
  assert.match(markdown, /submodule-autoupdate/);
});

test("workflow evidence is fetched only for active trusted workflow names", async () => {
  const policy = await readTriggerPolicy(root);
  const calls: string[] = [];
  const evidence = await collectLoopWorkflowEvidence({
    async request(method: string, requestPath: string) {
      calls.push(`${method} ${requestPath}`);
      return { workflow_runs: [] };
    }
  }, { owner: "marius-patrik", repo: "DarkFactory" }, policy);
  assert.ok(calls.every((call) => call.includes("/actions/workflows/") && call.includes("branch=main")));
  assert.equal(calls.some((call) => call.includes("df-release.yml")), true);
  assert.equal(calls.some((call) => call.includes("df-submodule-autoupdate.yml")), true);
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, ".github/workflows/df-orchestrate.yml"));
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, ".github/workflows/df-submodule-autoupdate.yml"));
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, ".github/workflows/df-autoreview-recovery.yml"));
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, ".github/workflows/df-clean.yml"));
});

test("shared GitHub transport accepts the rerun endpoint's successful empty 201 response", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 201 });
  };
  try {
    const gh = githubClientModule.createGithubClient("test-token", "empty-rerun-response-test");
    const result = await gh.request("POST", "/repos/marius-patrik/DarkFactory/actions/runs/5012/rerun");
    assert.equal(result, null);
    assert.deepEqual(calls.map((call) => [call.init?.method, call.url]), [[
      "POST",
      "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5012/rerun"
    ]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Autoreview recovery lifecycle-filters code repositories, reruns the exact PR gate, and dispatches exact issue versions", async () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const issue = { number: 9, title: "Exact issue", body: "Review this contract", state: "open", labels: [] };
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    base: { sha: SHA_A, ref: "dev" },
    head: { sha: SHA_B, ref: "feature/recover", repo: { full_name: "marius-patrik/DarkFactory" } }
  };
  const failedCheck = {
    id: 701,
    name: "DarkFactory Autoreview",
    app: { id: 15368 },
    head_sha: SHA_B,
    status: "completed",
    conclusion: "failure",
    check_suite: { id: 9001 },
    html_url: "https://github.com/marius-patrik/DarkFactory/runs/701"
  };
  const failedRun = {
    id: 5001,
    check_suite_id: 9001,
    event: "pull_request_target",
    head_sha: SHA_B,
    head_branch: "feature/recover",
    path: ".github/workflows/darkfactory-autoreview.yml",
    pull_requests: [{ number: 7, head: { sha: SHA_B, ref: "feature/recover" }, base: { sha: SHA_A, ref: "dev" } }],
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: "2026-07-16T11:00:00Z",
    html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5001",
    rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5001/rerun"
  };
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const ledgers: Array<{ kind: string; target: string; payload: any }> = [];
  let commentId = 100;
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory") return { archived: false, disabled: false };
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/DarkFactory/pulls?")) return [pull];
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/Andromeda/pulls?")) return [];
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/DarkFactory/issues?")) return [];
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/Andromeda/issues?")) return [issue];
      if (method === "GET" && /\/issues\/(?:7|9)\/comments\?/.test(requestPath)) return [];
      if (method === "GET" && requestPath.includes(`/commits/${SHA_B}/check-runs?check_name=DarkFactory%20Autoreview`)) return { total_count: 1, check_runs: [failedCheck] };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9001")) return { total_count: 1, workflow_runs: [failedRun] };
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/pulls/7") return pull;
      if (method === "GET" && requestPath === "/repos/marius-patrik/Andromeda/issues/9") return issue;
      if (method === "POST" && /\/issues\/(?:7|9)\/comments$/.test(requestPath)) return { id: commentId++, html_url: `https://github.com/comment/${commentId}` };
      if (method === "POST" && requestPath === "/repos/marius-patrik/DarkFactory/actions/runs/5001/rerun") return {};
      if (method === "POST" && requestPath.endsWith("/actions/workflows/darkfactory-autoreview.yml/dispatches")) return {};
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "c".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [
      { owner: "marius-patrik", repo: "Andromeda" },
      { owner: "marius-patrik", repo: "Andromeda-data" }
    ],
    dataRepositories: ["marius-patrik/Andromeda-data", "marius-patrik/darkfactory-data"],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger(kind: string, target: string, payload: any) { ledgers.push({ kind, target, payload }); }
  });
  const repositories = await recoveryModule.listRecoveryRepositories();
  assert.deepEqual(repositories.map((entry: any) => entry.repository), ["marius-patrik/Andromeda", "marius-patrik/DarkFactory"]);
  await assert.rejects(
    recoveryModule.listRecoveryRepositories({ repository: "marius-patrik/Andromeda-data" }),
    /not an active code repository/
  );
  const result = await recoveryModule.recoverAutoreviews({ kind: "all", maxDispatches: 4, trigger: "test" });
  assert.equal(result.dispatched.length, 2);
  const dispatches = calls.filter((call) => call.method === "POST" && call.path.endsWith("/dispatches"));
  assert.deepEqual(dispatches.map((call) => call.body.inputs.target_kind), ["issue"]);
  assert.ok(dispatches.every((call) => /^[0-9a-f]{64}$/.test(call.body.inputs.target_version)));
  assert.deepEqual(
    calls.filter((call) => call.method === "POST" && call.path.endsWith("/rerun")).map((call) => call.path),
    ["/repos/marius-patrik/DarkFactory/actions/runs/5001/rerun"]
  );
  assert.equal(result.dispatched.find((entry: any) => entry.kind === "pull_request").status, "rerun-requested");
  assert.equal(result.dispatched.find((entry: any) => entry.kind === "issue").status, "dispatched");
  assert.ok(ledgers.some((entry) => entry.kind === "autoreview-recovery-admission"));
  assert.ok(ledgers.some((entry) => entry.kind === "autoreview-recovery-completion"));
  assert.equal(calls.some((call) => /contents|git\/trees|tarball|zipball/.test(call.path)), false);
});

test("Autoreview recovery suppresses only an exact successful result with a current trusted green gate, plus fresh pending targets", async () => {
  const base = "d".repeat(40);
  const head = "e".repeat(40);
  const version = `${base}:${head}`;
  const trusted = { login: "darkfactory-agent[bot]", type: "Bot" };
  const pull = { number: 3, state: "open", draft: false, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feature/clean", repo: { full_name: "marius-patrik/DarkFactory" } } };
  const pendingPull = { ...pull, number: 4 };
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [pull, pendingPull];
      if (method === "GET" && requestPath.includes("/issues/3/comments?")) return [{
        user: trusted,
        created_at: "2026-07-16T11:59:00Z",
        body: `<!-- darkfactory-autoreview -->\n<!-- darkfactory-autoreview-target version=${version} -->\n## DarkFactory Autoreview\n\n**Verdict:** Clean high confirmation`
      }];
      if (method === "GET" && requestPath.includes("/issues/4/comments?")) return [{
        user: trusted,
        created_at: "2026-07-16T11:59:00Z",
        body: `<!-- darkfactory:clean-autoreview schema=1 kind=pull-request number=4 version=${version} status=pending -->\nadmitted`
      }];
      if (method === "GET" && requestPath.includes(`/commits/${head}/check-runs?check_name=DarkFactory%20Autoreview`)) return { total_count: 1, check_runs: [{
        id: 801,
        name: "DarkFactory Autoreview",
        app: { id: 15368 },
        head_sha: head,
        status: "completed",
        conclusion: "success",
        check_suite: { id: 9101 }
      }] };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9101")) return { total_count: 1, workflow_runs: [{
        id: 5_101,
        check_suite_id: 9_101,
        event: "pull_request_target",
        head_sha: head,
        head_branch: "feature/clean",
        path: ".github/workflows/darkfactory-autoreview.yml",
        pull_requests: [{ number: 3, head: { sha: head, ref: "feature/clean" }, base: { sha: base, ref: "main" } }],
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        created_at: "2026-07-16T11:00:00Z",
        html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5101",
        rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5101/rerun"
      }] };
      if (method === "GET" && requestPath.includes("/issues?")) return [];
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "f".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });
  const result = await recoveryModule.recoverAutoreviews({ kind: "all", maxDispatches: 2, trigger: "test" });
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.dispatched, []);
});

test("Autoreview recovery rejects a colliding PR-controlled Actions check even beside an exact green base-trusted gate", async () => {
  const base = "c".repeat(40);
  const head = "d".repeat(40);
  const version = `${base}:${head}`;
  const pull = {
    number: 19,
    state: "open",
    draft: false,
    base: { sha: base, ref: "dev" },
    head: { sha: head, ref: "feature/colliding-gate", repo: { full_name: "marius-patrik/DarkFactory" } }
  };
  const exactPull = [{
    number: 19,
    head: { sha: head, ref: "feature/colliding-gate" },
    base: { sha: base, ref: "dev" }
  }];
  const comments = [{
    id: 190,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    created_at: "2026-07-16T11:00:00Z",
    body: [
      "<!-- darkfactory-autoreview -->",
      `<!-- darkfactory-autoreview-target version=${version} -->`,
      "## DarkFactory Autoreview",
      "",
      "**Verdict:** Clean high confirmation"
    ].join("\n")
  }];
  const mutations: string[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [pull];
      if (method === "GET" && requestPath.includes("/issues/19/comments?")) return comments;
      if (method === "GET" && requestPath.includes(`/commits/${head}/check-runs?check_name=DarkFactory%20Autoreview`)) return {
        total_count: 2,
        check_runs: [{
          id: 919,
          name: "DarkFactory Autoreview",
          app: { id: 15368 },
          head_sha: head,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 9_201 }
        }, {
          id: 920,
          name: "DarkFactory Autoreview",
          app: { id: 15368 },
          head_sha: head,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 9_202 }
        }]
      };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9201")) return { total_count: 1, workflow_runs: [{
        id: 5_201,
        check_suite_id: 9_201,
        event: "pull_request_target",
        head_sha: head,
        head_branch: "feature/colliding-gate",
        path: ".github/workflows/darkfactory-autoreview.yml",
        pull_requests: exactPull,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        created_at: "2026-07-16T11:00:00Z",
        html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5201",
        rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5201/rerun"
      }] };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9202")) return { total_count: 1, workflow_runs: [{
        id: 5_202,
        check_suite_id: 9_202,
        event: "pull_request",
        head_sha: head,
        head_branch: "feature/colliding-gate",
        path: ".github/workflows/pr-controlled-collision.yml",
        pull_requests: exactPull,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        created_at: "2026-07-16T11:00:00Z",
        html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5202",
        rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5202/rerun"
      }] };
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/pulls/19") return pull;
      mutations.push(`${method} ${requestPath}`);
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "e".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "pull_request", maxDispatches: 2, trigger: "test" });
  assert.equal(result.status, "owner-required");
  assert.equal(result.candidates, 1);
  assert.equal(result.dispatched[0].recoveryReason, "trusted-current-gate-collision");
  assert.equal(result.dispatched[0].gate.state, "collision");
  assert.equal(result.dispatched[0].gate.bound[0].workflowRun.event, "pull_request_target");
  assert.equal(result.dispatched[0].gate.rejected[0].workflowRun.observedRuns[0].event, "pull_request");
  assert.equal(result.dispatched[0].gate.rejected[0].workflowRun.observedRuns[0].path, ".github/workflows/pr-controlled-collision.yml");
  assert.deepEqual(mutations, []);
});

test("Autoreview recovery reruns an exact failed PR gate even when its exact trusted result comment is clean", async () => {
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  const version = `${base}:${head}`;
  const pull = {
    number: 12,
    state: "open",
    draft: false,
    base: { sha: base, ref: "dev" },
    head: { sha: head, ref: "feature/clean-red", repo: { full_name: "marius-patrik/DarkFactory" } }
  };
  const comments: any[] = [{
    id: 120,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    created_at: "2026-07-16T11:00:00Z",
    body: [
      "<!-- darkfactory-autoreview -->",
      `<!-- darkfactory-autoreview-target version=${version} -->`,
      "## DarkFactory Autoreview",
      "",
      "**Verdict:** Clean high confirmation"
    ].join("\n")
  }];
  const mutations: Array<{ method: string; path: string; body?: any }> = [];
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [pull];
      if (method === "GET" && requestPath.includes("/issues/12/comments?")) return comments;
      if (method === "GET" && requestPath.includes("/issues?")) return [];
      if (method === "GET" && requestPath.includes(`/commits/${head}/check-runs?check_name=DarkFactory%20Autoreview`)) return { total_count: 1, check_runs: [{
        id: 812,
        name: "DarkFactory Autoreview",
        app: { id: 15368 },
        head_sha: head,
        status: "completed",
        conclusion: "failure",
        check_suite: { id: 9_112 }
      }] };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9112")) return { total_count: 1, workflow_runs: [{
        id: 5_012,
        check_suite_id: 9_112,
        event: "pull_request_target",
        head_sha: head,
        head_branch: "feature/clean-red",
        path: ".github/workflows/darkfactory-autoreview.yml",
        pull_requests: [{ number: 12, head: { sha: head, ref: "feature/clean-red" }, base: { sha: base, ref: "dev" } }],
        status: "completed",
        conclusion: "failure",
        run_attempt: 1,
        created_at: "2026-07-16T11:00:00Z",
        html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5012",
        rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5012/rerun"
      }] };
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/pulls/12") return pull;
      if (method === "POST" && requestPath.endsWith("/issues/12/comments")) {
        const comment = { id: 121, user: { login: "darkfactory-agent[bot]", type: "Bot" }, created_at: "2026-07-16T12:00:00Z", body: body.body };
        comments.push(comment);
        mutations.push({ method, path: requestPath, body });
        return comment;
      }
      if (method === "POST" && requestPath.endsWith("/actions/runs/5012/rerun")) {
        mutations.push({ method, path: requestPath, body });
        return {};
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "3".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "pull_request", maxDispatches: 2, trigger: "test" });
  assert.equal(result.status, "complete");
  assert.equal(result.dispatched[0].status, "rerun-requested");
  assert.equal(result.dispatched[0].recoveryReason, "successful-comment-with-red-gate");
  assert.deepEqual(mutations.filter((call) => call.path.endsWith("/rerun")).map((call) => call.path), [
    "/repos/marius-patrik/DarkFactory/actions/runs/5012/rerun"
  ]);
  assert.equal(mutations.some((call) => call.path.endsWith("/dispatches")), false);
});

test("Autoreview recovery suppresses a trusted pending PR gate without rerunning or dispatching", async () => {
  const base = "4".repeat(40);
  const head = "5".repeat(40);
  const pull = {
    number: 15,
    state: "open",
    draft: false,
    base: { sha: base, ref: "main" },
    head: { sha: head, ref: "feature/pending", repo: { full_name: "marius-patrik/DarkFactory" } }
  };
  const mutations: string[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [pull];
      if (method === "GET" && requestPath.includes("/issues/15/comments?")) return [];
      if (method === "GET" && requestPath.includes(`/commits/${head}/check-runs?check_name=DarkFactory%20Autoreview`)) return { total_count: 1, check_runs: [{
        id: 815,
        name: "DarkFactory Autoreview",
        app: { id: 15368 },
        head_sha: head,
        status: "in_progress",
        conclusion: null,
        check_suite: { id: 9_115 }
      }] };
      if (method === "GET" && requestPath.includes("/actions/runs?check_suite_id=9115")) return { total_count: 1, workflow_runs: [{
        id: 5_115,
        check_suite_id: 9_115,
        event: "pull_request_target",
        head_sha: head,
        head_branch: "feature/pending",
        path: ".github/workflows/darkfactory-autoreview.yml",
        pull_requests: [{ number: 15, head: { sha: head, ref: "feature/pending" }, base: { sha: base, ref: "main" } }],
        status: "in_progress",
        conclusion: null,
        run_attempt: 1,
        created_at: "2026-07-16T11:00:00Z",
        html_url: "https://github.com/marius-patrik/DarkFactory/actions/runs/5115",
        rerun_url: "https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/5115/rerun"
      }] };
      if (method === "GET" && requestPath.includes("/issues?")) return [];
      mutations.push(`${method} ${requestPath}`);
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "6".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "pull_request", maxDispatches: 2, trigger: "test" });
  assert.equal(result.candidates, 0);
  assert.deepEqual(mutations, []);
});

test("Autoreview recovery fails closed before suppression when GitHub truncates the named check inventory", async () => {
  const base = "7".repeat(40);
  const head = "8".repeat(40);
  const pull = {
    number: 20,
    state: "open",
    draft: false,
    base: { sha: base, ref: "main" },
    head: { sha: head, ref: "feature/truncated-checks", repo: { full_name: "marius-patrik/DarkFactory" } }
  };
  const mutations: string[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [pull];
      if (method === "GET" && requestPath.includes("/issues/20/comments?")) return [];
      if (method === "GET" && requestPath.includes(`/commits/${head}/check-runs?check_name=DarkFactory%20Autoreview`)) return {
        total_count: 2,
        check_runs: [{
          id: 820,
          name: "DarkFactory Autoreview",
          app: { id: 15368 },
          head_sha: head,
          status: "completed",
          conclusion: "failure",
          check_suite: { id: 9_220 }
        }]
      };
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/pulls/20") return pull;
      mutations.push(`${method} ${requestPath}`);
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "9".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "pull_request", maxDispatches: 2, trigger: "test" });
  assert.equal(result.status, "owner-required");
  assert.equal(result.dispatched[0].recoveryReason, "trusted-current-gate-inventory-truncated-or-malformed");
  assert.deepEqual(result.dispatched[0].gate, { state: "unobservable", totalCount: 2, observedCount: 1 });
  assert.deepEqual(mutations, []);
});

test("Autoreview recovery fails closed with owner evidence for missing, ambiguous, and non-rerunnable exact PR runs", async () => {
  const pulls = [16, 17, 18].map((number, index) => ({
    number,
    state: "open",
    draft: false,
    base: { sha: String(number - 10).repeat(40), ref: "main" },
    head: { sha: ["9", "a", "b"][index].repeat(40), ref: `feature/fail-closed-${number}`, repo: { full_name: "marius-patrik/DarkFactory" } }
  }));
  const exactRun = (pull: any, id: number, suite: number, overrides: Record<string, any> = {}) => ({
    id,
    check_suite_id: suite,
    event: "pull_request_target",
    head_sha: pull.head.sha,
    head_branch: pull.head.ref,
    path: ".github/workflows/darkfactory-autoreview.yml",
    pull_requests: [{ number: pull.number, head: { sha: pull.head.sha, ref: pull.head.ref }, base: { sha: pull.base.sha, ref: pull.base.ref } }],
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: "2026-07-16T11:00:00Z",
    html_url: `https://github.com/marius-patrik/DarkFactory/actions/runs/${id}`,
    rerun_url: `https://api.github.com/repos/marius-patrik/DarkFactory/actions/runs/${id}/rerun`,
    ...overrides
  });
  const ledgers: Array<{ kind: string; payload: any }> = [];
  const mutations: string[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/pulls?")) return pulls;
      if (method === "GET" && /\/issues\/(?:16|17|18)\/comments\?/.test(requestPath)) return [];
      if (method === "GET" && requestPath.includes("/issues?")) return [];
      const checkMatch = /\/commits\/([0-9a-f]+)\/check-runs\?/.exec(requestPath);
      if (method === "GET" && checkMatch) {
        const pull = pulls.find((entry) => entry.head.sha === checkMatch[1]);
        if (!pull) throw new Error(`unknown check head ${checkMatch[1]}`);
        return { total_count: 1, check_runs: [{
          id: 800 + pull.number,
          name: "DarkFactory Autoreview",
          app: { id: 15368 },
          head_sha: pull.head.sha,
          status: "completed",
          conclusion: "failure",
          check_suite: { id: 9_100 + pull.number }
        }] };
      }
      const runMatch = /check_suite_id=(\d+)/.exec(requestPath);
      if (method === "GET" && runMatch) {
        const suite = Number(runMatch[1]);
        const pull = pulls.find((entry) => 9_100 + entry.number === suite)!;
        if (pull.number === 16) return { total_count: 1, workflow_runs: [exactRun(pull, 5_016, suite, {
          pull_requests: [{
            number: pull.number,
            head: { sha: pull.head.sha, ref: pull.head.ref },
            base: { sha: "0".repeat(40), ref: pull.base.ref }
          }]
        })] };
        if (pull.number === 17) return { total_count: 2, workflow_runs: [exactRun(pull, 5_017, suite), exactRun(pull, 6_017, suite)] };
        return { total_count: 1, workflow_runs: [exactRun(pull, 5_018, suite, { rerun_url: null })] };
      }
      const pullMatch = /\/pulls\/(16|17|18)$/.exec(requestPath);
      if (method === "GET" && pullMatch) return pulls.find((entry) => entry.number === Number(pullMatch[1]));
      mutations.push(`${method} ${requestPath}`);
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "c".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger(kind: string, _target: string, payload: any) { ledgers.push({ kind, payload }); }
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "pull_request", maxDispatches: 4, trigger: "test" });
  assert.equal(result.status, "owner-required");
  assert.deepEqual(result.dispatched.map((entry: any) => [entry.number, entry.status, entry.recoveryReason]), [
    [16, "owner-required", "exact-pull-request-target-run-missing"],
    [17, "owner-required", "exact-pull-request-target-run-ambiguous"],
    [18, "owner-required", "exact-pull-request-target-run-not-rerunnable"]
  ]);
  assert.deepEqual(result.dispatched[0].workflowRun.observedRunIds, [5_016]);
  assert.deepEqual(result.dispatched[1].workflowRun.runIds, [5_017, 6_017]);
  assert.equal(result.dispatched[2].workflowRun.rerunUrl, null);
  assert.equal(ledgers.filter((entry) => entry.kind === "autoreview-recovery-owner-required").length, 3);
  assert.equal(ledgers.every((entry) => entry.kind !== "autoreview-recovery-dispatch" || entry.payload.status !== "dispatched"), true);
  assert.deepEqual(mutations, []);
});

test("Autoreview result classification admits only exact trusted clean or owner-override verdicts", () => {
  const version = `${"1".repeat(40)}:${"2".repeat(40)}`;
  const trusted = { login: "darkfactory-agent[bot]", type: "Bot" };
  const result = (verdict: string, user = trusted, targetVersion = version, suffix = "") => [{
    user,
    body: [
      "<!-- darkfactory-autoreview -->",
      `<!-- darkfactory-autoreview-target version=${targetVersion} -->`,
      "## DarkFactory Autoreview",
      "",
      `**Verdict:** ${verdict}`,
      suffix
    ].join("\n")
  }];

  assert.equal(autoreviewRunner.classifyExactAutoreviewResult(result("Clean high confirmation"), version), "clean");
  assert.equal(autoreviewRunner.classifyExactAutoreviewResult(result("Blocked closed"), version), "blocked");
  assert.equal(autoreviewRunner.classifyExactAutoreviewResult(result("Auditable owner override"), version), "owner_override");
  assert.equal(autoreviewRunner.classifyExactAutoreviewResult(result("Clean high confirmation", { login: "attacker", type: "User" }), version), "none");
  assert.equal(autoreviewRunner.classifyExactAutoreviewResult(result("Clean high confirmation", trusted, `${"3".repeat(40)}:${"4".repeat(40)}`), version), "stale");
  assert.equal(
    autoreviewRunner.classifyExactAutoreviewResult(result("Blocked closed", trusted, version, "**Verdict:** Clean high confirmation"), version),
    "blocked"
  );
});

test("Autoreview recovery retries blocked results and dispatches exact reviewed-label repair only when needed", async () => {
  const trusted = { login: "darkfactory-agent[bot]", type: "Bot" };
  const issues = [
    { number: 8, title: "Repair label", body: "# Goal\n\nRepair", state: "open", labels: [] },
    { number: 9, title: "Already clean", body: "# Goal\n\nClean", state: "open", labels: [{ name: "df:reviewed" }] },
    { number: 10, title: "Owner override", body: "# Goal\n\nOverride", state: "open", labels: ["df:reviewed"] },
    { number: 11, title: "Retry blocked", body: "# Goal\n\nBlocked", state: "open", labels: [] }
  ];
  const verdicts = new Map([[8, "Clean high confirmation"], [9, "Clean high confirmation"], [10, "Auditable owner override"], [11, "Blocked closed"]]);
  const comments = new Map<number, any[]>(issues.map((issue) => [issue.number, [{
    id: issue.number * 10,
    user: trusted,
    created_at: "2026-07-16T10:00:00Z",
    body: [
      "<!-- darkfactory-autoreview -->",
      `<!-- darkfactory-autoreview-target version=${issueVersion(issue)} -->`,
      "## DarkFactory Autoreview",
      "",
      `**Verdict:** ${verdicts.get(issue.number)}`
    ].join("\n")
  }]]));
  const dispatches: any[] = [];
  let nextCommentId = 1_000;
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      if (method === "GET" && requestPath.includes("/pulls?")) return [];
      if (method === "GET" && requestPath.includes("/issues?state=open")) return issues;
      const commentMatch = /\/issues\/(\d+)\/comments\?/.exec(requestPath);
      if (method === "GET" && commentMatch) return comments.get(Number(commentMatch[1])) || [];
      const issueMatch = /\/issues\/(\d+)$/.exec(requestPath);
      if (method === "GET" && issueMatch) return issues.find((issue) => issue.number === Number(issueMatch[1]));
      const commentPost = /\/issues\/(\d+)\/comments$/.exec(requestPath);
      if (method === "POST" && commentPost) {
        const number = Number(commentPost[1]);
        const comment = { id: nextCommentId++, user: trusted, created_at: "2026-07-16T12:00:00Z", body: body.body, html_url: `https://github.com/comment/${nextCommentId}` };
        comments.get(number)?.push(comment);
        return comment;
      }
      if (method === "POST" && requestPath.endsWith("/actions/workflows/darkfactory-autoreview.yml/dispatches")) {
        dispatches.push(body);
        return {};
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  recoveryModule.configureAutoreviewRecoveryRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    controlRevision: "a".repeat(40),
    controlMetadata: { archived: false, disabled: false },
    activeRepositories: [],
    dataRepositories: [],
    now: Date.parse("2026-07-16T12:00:00Z"),
    async writeLedger() {}
  });

  const result = await recoveryModule.recoverAutoreviews({ kind: "issue", maxDispatches: 4, trigger: "test" });
  assert.equal(result.candidates, 2);
  assert.deepEqual(result.dispatched.map((entry: any) => [entry.number, entry.recoveryReason]), [
    [8, "reviewed-label-repair"],
    [11, "blocked-result"]
  ]);
  assert.deepEqual(dispatches.map((entry) => Number(entry.inputs.target_number)), [8, 11]);
});

test("active recovery workflows bind trusted main, Agent OS, scoped tokens, exact plans, and no bypasses", async () => {
  const [recovery, clean, managed] = await Promise.all([
    readFile(path.join(root, ".github/workflows/df-autoreview-recovery.yml"), "utf8"),
    readFile(path.join(root, ".github/workflows/df-clean.yml"), "utf8"),
    readFile(path.join(root, ".darkfactory/managed-repository.json"), "utf8")
  ]);
  assert.match(recovery, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(recovery, /bin\\agents\.ps1/);
  assert.match(recovery, /permission-actions: write/);
  assert.match(recovery, /repositories: darkfactory-data[\s\S]*permission-contents: write/);
  assert.match(recovery, /df-autoreview-recovery\.mjs/);
  assert.doesNotMatch(recovery, /checkout[^\n]*pull_request|github\.event\.pull_request\.head/);

  assert.match(clean, /cron: "53 \*\/4 \* \* \*"/);
  assert.match(clean, /packages run darkfactory -- clean plan/);
  assert.match(clean, /packages run darkfactory -- clean apply \$planId --local \$target --watch --json/);
  assert.match(clean, /packages run darkfactory -- clean verify/);
  assert.match(clean, /DF_CONTROL_REVISION: \$\{\{ needs\.discover\.outputs\.control_revision \}\}/);
  assert.match(clean, /Materialize exact local target without executing it/);
  assert.doesNotMatch(`${recovery}\n${clean}`, /--force|--bypass|reset --hard|checkout --force/);

  const manifest = JSON.parse(managed);
  for (const required of [
    ".github/workflows/df-autoreview-recovery.yml",
    ".github/workflows/df-clean.yml",
    ".github/scripts/df-autoreview-recovery.mjs"
  ]) {
    assert.ok(manifest.packageFiles.includes(required), `${required} is package-owned`);
    assert.ok(manifest.requiredFiles.includes(required), `${required} is required`);
  }
});

test("one-time reconciliation bootstrap is exact-state-bound and publishes only a new isolated App ref", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/df-reconcile-bootstrap.yml"), "utf8");
  const expectedDev = "c512258f6bb6f429f2c8779087c28f196570a1be";

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}(pull_request|push|schedule):/m);
  assert.match(workflow, /GITHUB_REPOSITORY.*marius-patrik\/DarkFactory.*GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, new RegExp(`const expectedDev = "${expectedDev}"`));
  assert.match(workflow, /getRef\(\{ owner, repo, ref: "heads\/main" \}\)/);
  assert.match(workflow, /getRef\(\{ owner, repo, ref: "heads\/dev" \}\)/);
  assert.match(workflow, /mainRef\.object\.sha !== main/);
  assert.match(workflow, /devRef\.object\.sha !== expectedDev/);
  assert.match(workflow, /getRef\(\{ owner, repo, ref: `heads\/\$\{branch\}` \}\)[\s\S]*already exists; refusing to overwrite/);
  assert.match(workflow, /createCommit\(\{[\s\S]*tree: devCommit\.commit\.tree\.sha,[\s\S]*parents: \[expectedDev, main\]/);
  assert.match(workflow, /createRef\(\{[\s\S]*ref: `refs\/heads\/\$\{branch\}`,[\s\S]*sha: commit\.sha/);
  assert.doesNotMatch(workflow, /updateRef|force:\s*true|refs\/heads\/(?:main|dev)`/);
  assert.match(workflow, /repositories: DarkFactory[\s\S]*permission-contents: write/);
});
