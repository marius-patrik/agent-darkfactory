import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// @ts-ignore Native ESM workflow policy is exercised directly.
const policyModule: any = await import("../.github/scripts/df-trigger-policy.mjs");
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
  assert.equal(policy.policyVersion, "1.0.0");
  assert.deepEqual(policy.loops.map((loop: any) => loop.id).sort(), [...REQUIRED_LOOP_IDS].sort());
  for (const loop of policy.loops) {
    assert.match(loop.idempotencyKey, /\{repository\}.*\{target\}.*\{sourceVersion\}/);
    assert.ok(loop.recovery.maxDetectionMinutes >= loop.recovery.intervalMinutes);
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
  assert.throws(
    () => admitLoopInvocation(policy, "release-convergence", context, new Date("2026-07-15T10:05:00.000Z")),
    /planned, not active/
  );
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
  const release = statuses.find((entry: any) => entry.id === "release-convergence");
  assert.equal(release.retry, "blocked-by:#41");
  const markdown = loopStatusMarkdownRows(statuses);
  assert.match(markdown, /worker-dispatch/);
  assert.match(markdown, /blocked-by:#41/);
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
  assert.equal(calls.some((call) => call.includes("df-release.yml")), false);
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, ".github/workflows/df-orchestrate.yml"));
});
