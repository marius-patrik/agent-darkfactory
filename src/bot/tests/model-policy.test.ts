import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// @ts-ignore Workflow policy helpers are native ESM, not built TypeScript modules.
const policyModule: any = await import("../../../scripts/df-model-policy.mjs");

const {
  agentRunArguments,
  loadModelPolicy,
  modelRequestForPurpose,
  validateAgentExecutionReceipt,
  validateModelPolicy
} = policyModule;

const controlRoot = path.resolve(import.meta.dirname, "..");

test("model tier and effort policy is versioned and independent", async () => {
  const policy = await loadModelPolicy(controlRoot);
  const cases = [
    ["mechanical", "low", "low"],
    ["standard", "medium", "medium"],
    ["hard", "medium", "high"]
  ];
  for (const [taskClass, modelTier, effort] of cases) {
    const request = modelRequestForPurpose(policy, "implementation", { taskClass });
    assert.equal(request.modelTier, modelTier);
    assert.equal(request.effort, effort);
    assert.equal(request.taskClass, taskClass);
  }
  assert.deepEqual(
    ["planning", "orchestration", "issueDrafting", "finalReview"].map((purpose) => modelRequestForPurpose(policy, purpose).modelTier),
    ["high", "high", "high", "high"]
  );
  assert.equal(modelRequestForPurpose(policy, "iterativeReview").modelTier, "medium");
  assert.throws(() => modelRequestForPurpose(policy, "explicitMaximum"), /owner authorization/);
  assert.equal(
    modelRequestForPurpose(policy, "explicitMaximum", { ownerAuthorized: true, authorizationRef: "issue:35#owner" }).modelTier,
    "max"
  );
});

test("policy rejects tier crossing and low-tier use outside proven mechanical work", async () => {
  const policy = structuredClone(await loadModelPolicy(controlRoot));
  policy.purposes.implementation.standard.modelTier = "low";
  assert.throws(() => validateModelPolicy(policy), /standard implementation must use the medium tier/);

  const crossed = structuredClone(await loadModelPolicy(controlRoot));
  crossed.purposes.finalReview.modelTier = "medium";
  assert.throws(() => validateModelPolicy(crossed), /finalReview must use the high tier/);
});

test("all four logical tiers produce only canonical agents CLI arguments", async () => {
  const policy = await loadModelPolicy(controlRoot);
  const requests = [
    modelRequestForPurpose(policy, "implementation", { taskClass: "mechanical" }),
    modelRequestForPurpose(policy, "implementation", { taskClass: "standard" }),
    modelRequestForPurpose(policy, "planning"),
    modelRequestForPurpose(policy, "explicitMaximum", { ownerAuthorized: true, authorizationRef: "issue:35#owner" })
  ];
  const receiptPath = path.resolve(controlRoot, ".agents", "test-receipt.json");
  assert.deepEqual(requests.map((request: any) => request.modelTier), ["low", "medium", "high", "max"]);
  for (const request of requests) {
    const args = agentRunArguments(request, {
      prompt: "bounded fixture prompt",
      receiptPath,
      executionPolicy: "workspace-write"
    });
    assert.deepEqual(args.slice(0, 2), ["run", "--mode"]);
    assert.equal(args[args.indexOf("--model-tier") + 1], request.modelTier);
    assert.equal(args[args.indexOf("--effort") + 1], request.effort);
    assert.equal(args[args.indexOf("--execution-policy") + 1], "workspace-write");
    assert.equal(args[args.indexOf("--receipt") + 1], receiptPath);
    assert.doesNotMatch(args.join(" "), /(?:^|\s)(?:kimi|agy|codex|claude)(?:\s|$)|auth\.json|credentials/i);
  }

  const promptFile = path.resolve(controlRoot, ".agents", "bounded-review-prompt.txt");
  const fileArgs = agentRunArguments(requests[1], {
    promptFile,
    receiptPath,
    executionPolicy: "read-only"
  });
  assert.equal(fileArgs[fileArgs.indexOf("--prompt-file") + 1], promptFile);
  assert.equal(fileArgs.at(-1), promptFile);
  assert.throws(() => agentRunArguments(requests[1], {
    prompt: "ambiguous",
    promptFile,
    receiptPath
  }), /Exactly one/);
});

test("execution receipts match the request and expose only sanitized route evidence", async () => {
  const policy = await loadModelPolicy(controlRoot);
  const request = modelRequestForPurpose(policy, "implementation", { taskClass: "standard" });
  const receipt = {
    schemaVersion: 2,
    requested: { modelTier: "medium", effort: "medium" },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: {
      provider: "fixture-provider",
      model: "fixture/model-v1",
      agentPreset: "Fixture",
      providerVersion: "1.2.3",
      toolPolicy: "standard"
    },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    outcome: "success",
    blockReason: null
  };
  assert.deepEqual(validateAgentExecutionReceipt(receipt, request), receipt);
  assert.throws(
    () => validateAgentExecutionReceipt({ ...receipt, requested: { modelTier: "high", effort: "medium" } }, request),
    /does not match/
  );
  assert.throws(
    () => validateAgentExecutionReceipt({ ...receipt, secret: "must-not-leak" }, request),
    /must contain exactly|forbidden secret/
  );
  assert.throws(
    () => validateAgentExecutionReceipt({ ...receipt, outcome: "blocked", blockReason: "quota_exhausted" }, request),
    /execution blocked/
  );
  assert.equal(
    validateAgentExecutionReceipt({
      ...receipt,
      attempts: [{ number: 1, outcome: "blocked", reason: "quota_exhausted" }],
      outcome: "blocked",
      blockReason: "quota_exhausted"
    }, request, { allowBlocked: true }).outcome,
    "blocked"
  );
});
