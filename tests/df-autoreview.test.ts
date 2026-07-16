import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// @ts-ignore Workflow protocol helpers are native ESM, not built TypeScript modules.
const autoreviewModule: any = await import("../.github/scripts/df-autoreview.mjs");
// @ts-ignore Workflow policy helpers are native ESM, not built TypeScript modules.
const modelModule: any = await import("../.github/scripts/df-model-policy.mjs");
// @ts-ignore Workflow entrypoint helpers are native ESM, not built TypeScript modules.
const autoreviewRunnerModule: any = await import("../.github/scripts/run-darkfactory-autoreview.mjs");

const {
  loadAutoreviewPolicy,
  normalizeAutoreviewVerdict,
  runAutoreview,
  validateAutofixProposal,
  validateAutoreviewPolicy
} = autoreviewModule;
const { loadModelPolicy } = modelModule;
const { assertAutoreviewLifecycle } = autoreviewRunnerModule;
const controlRoot = path.resolve(import.meta.dirname, "..");

function clean(summary = "Complete review found no blocking issues.") {
  return {
    schemaVersion: 1,
    approved: true,
    summary,
    findingsComplete: true,
    blockingFindings: [],
    nonBlockingNotes: []
  };
}

function findings(label = "Preserve the trust boundary") {
  return {
    schemaVersion: 1,
    approved: false,
    summary: "The complete review found one blocking issue.",
    findingsComplete: true,
    blockingFindings: [{
      title: label,
      details: "The target mutation can race a concurrent owner edit.",
      path: "src/target.ts",
      line: 42
    }],
    nonBlockingNotes: []
  };
}

function receipt(request: any, outcome = "success") {
  return {
    schemaVersion: 2,
    requested: { modelTier: request.modelTier, effort: request.effort },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: {
        provider: `fixture-${request.modelTier}`,
        model: `fixture/${request.modelTier}-model`,
        agentPreset: `Fixture-${request.modelTier}`,
        providerVersion: "1.0.0"
      },
      skipped: [{
        provider: "fixture-unavailable",
        model: "fixture/unavailable-model",
        agentPreset: "Fixture-Unavailable",
        providerVersion: "0.9.0",
        reason: "credential_missing"
      }]
    },
    resolved: {
      provider: outcome === "success" ? `fixture-${request.modelTier}` : "unresolved",
      model: outcome === "success" ? `fixture/${request.modelTier}-model` : "unresolved",
      agentPreset: outcome === "success" ? `Fixture-${request.modelTier}` : "unresolved",
      providerVersion: outcome === "success" ? "1.0.0" : "unresolved"
    },
    attempts: [{ number: 1, outcome, reason: outcome === "success" ? null : "route_unavailable" }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    outcome,
    blockReason: outcome === "success" ? null : "route_unavailable"
  };
}

function prompt(request: any) {
  const checksum = `sha256:${"0".repeat(64)}`;
  const high = request.modelTier === "high";
  return {
    schemaVersion: 1,
    controlRevision: "0123456789abcdef0123456789abcdef01234567",
    manifest: {
      library: "darkfactory-prompts",
      schemaVersion: 2,
      contractVersion: "0.3.0",
      checksum
    },
    promptChecksum: checksum,
    inputChecksum: checksum,
    profile: {
      id: high ? "profile/pr-final-review" : "profile/pr-reviewer",
      version: "0.2.0",
      runKind: "review-pr",
      purpose: high ? "final-review" : "iterative-review"
    },
    selection: {
      role: "role/pr-reviewer",
      skills: ["skill/validation-autoreview"],
      modelTier: request.modelTier,
      effort: request.effort,
      overlays: ["overlay/pr-review-fix"],
      repositoryOverlay: "overlay/bun-node",
      output: "output/pr-reviewer"
    },
    artifacts: [{ id: "output/pr-reviewer", version: "0.3.0", checksum }]
  };
}

async function fixture(options: { verdicts: any[]; policy?: any; mutateDuringReviewAt?: number; recordFailsAt?: number; promptMismatchAt?: number }) {
  const policy = options.policy || await loadAutoreviewPolicy(controlRoot);
  const modelPolicy = await loadModelPolicy(controlRoot);
  let version = "v1";
  let reviewIndex = 0;
  let fixCount = 0;
  const records: any[] = [];
  const fixInputs: any[] = [];
  const target = {
    read: async () => ({ kind: "pull_request", repository: "example/project", number: 7, version }),
    fix: async (input: any) => {
      fixInputs.push(input);
      const beforeVersion = version;
      version = `v${++fixCount + 1}`;
      return {
        beforeVersion,
        afterVersion: version,
        changeRef: `commit-${fixCount}`,
        receipt: receipt(input.request),
        prompt: prompt(input.request)
      };
    }
  };
  const result = await runAutoreview({
    policy,
    modelPolicy,
    target,
    review: async (input: any) => {
      const scripted = options.verdicts[reviewIndex];
      reviewIndex += 1;
      if (options.mutateDuringReviewAt === reviewIndex) version = "owner-edit";
      const promptEvidence = prompt(input.request);
      if (options.promptMismatchAt === reviewIndex) promptEvidence.selection.modelTier = "max";
      if (scripted?.routeBlocked) {
        return { verdict: clean(), receipt: receipt(input.request, "blocked"), prompt: promptEvidence };
      }
      return {
        verdict: typeof scripted === "function" ? scripted(input) : scripted,
        receipt: receipt(input.request),
        prompt: promptEvidence
      };
    },
    record: async (round: any) => {
      if (options.recordFailsAt === records.length + 1) throw new Error("ledger unavailable");
      records.push(round);
    }
  });
  return { result, records, fixInputs };
}

test("Autoreview policy is versioned, bounded, and keeps managed trust surfaces out of autofix", async () => {
  const policy = await loadAutoreviewPolicy(controlRoot);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.promptVersion, "darkfactory-autoreview-v1");
  assert.ok(policy.roundBudgets.medium > policy.roundBudgets.high);
  assert.ok(policy.protectedAutofixPaths.includes(".github/"));
  assert.ok(policy.protectedAutofixPaths.includes("package.json"));

  const unbounded = structuredClone(policy);
  unbounded.roundBudgets.medium = 1000;
  assert.throws(() => validateAutoreviewPolicy(unbounded), /medium round budget/);
});

test("Autoreview lifecycle admission uses the trusted canonical registry before work", () => {
  const registry = {
    schemaVersion: 1,
    repositories: {
      "marius-patrik/andromeda": { state: "active" },
      "example/parked": { state: "parked" },
      "example/completed": { state: "completed" }
    }
  };

  assert.equal(
    assertAutoreviewLifecycle({ owner: "marius-patrik", repo: "DarkFactory" }, registry),
    "control"
  );
  assert.equal(
    assertAutoreviewLifecycle({ owner: "marius-patrik", repo: "Andromeda" }, registry),
    "active"
  );
  for (const [repository, state] of [
    [{ owner: "example", repo: "parked" }, "parked"],
    [{ owner: "example", repo: "completed" }, "completed"],
    [{ owner: "example", repo: "unregistered" }, "removed"]
  ] as const) {
    assert.throws(
      () => assertAutoreviewLifecycle(repository, registry),
      (error: any) => error?.code === "target_lifecycle_blocked" && error.message.includes(state)
    );
  }
});

test("clean medium review is followed by an independent clean high confirmation", async () => {
  const { result, records, fixInputs } = await fixture({ verdicts: [clean("medium clean"), clean("high clean")] });
  assert.equal(result.ok, true);
  assert.deepEqual(records.map((round) => round.phase), ["medium_review", "high_review"]);
  assert.deepEqual(records.map((round) => round.request.modelTier), ["medium", "high"]);
  assert.equal(fixInputs.length, 0);
});

test("medium findings are losslessly carried into medium autofix before clean and high review", async () => {
  const first = findings("Stable medium finding");
  const { result, records, fixInputs } = await fixture({ verdicts: [first, clean(), clean()] });
  assert.equal(result.ok, true);
  assert.deepEqual(records.map((round) => round.phase), ["medium_review", "medium_fix", "medium_review", "high_review"]);
  assert.equal(fixInputs.length, 1);
  assert.equal(fixInputs[0].request.modelTier, "medium");
  assert.equal(fixInputs[0].findings[0].title, first.blockingFindings[0].title);
  assert.match(fixInputs[0].findings[0].id, /^df-[a-f0-9]{20}$/);
});

test("a high finding returns through medium fix and medium-to-clean before high repeats", async () => {
  const { result, records, fixInputs } = await fixture({ verdicts: [clean(), findings("High confirmation gap"), clean(), clean()] });
  assert.equal(result.ok, true);
  assert.deepEqual(records.map((round) => round.phase), [
    "medium_review",
    "high_review",
    "high_finding_fix",
    "medium_review",
    "high_review"
  ]);
  assert.equal(fixInputs[0].request.modelTier, "medium");
  assert.equal(records.at(-1).request.modelTier, "high");
});

test("malformed or incomplete verdicts fail closed without mutation", async () => {
  const malformed = { ...clean(), findingsComplete: false };
  const { result, records, fixInputs } = await fixture({ verdicts: [malformed] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed_verdict");
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "blocked");
  assert.equal(records[0].blockCode, "malformed_verdict");
  assert.equal(records[0].receipt.outcome, "success");
  assert.equal(fixInputs.length, 0);
});

test("prompt and routing provenance mismatch fails closed with both receipts", async () => {
  const { result, records, fixInputs } = await fixture({ verdicts: [clean()], promptMismatchAt: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed_verdict");
  assert.equal(records.length, 1);
  assert.equal(records[0].prompt.selection.modelTier, "max");
  assert.equal(records[0].receipt.requested.modelTier, "medium");
  assert.equal(fixInputs.length, 0);
});

test("concurrent target edits are detected after review and never overwritten", async () => {
  const { result, records, fixInputs } = await fixture({ verdicts: [findings()], mutateDuringReviewAt: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_target");
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "blocked");
  assert.equal(records[0].blockCode, "stale_target");
  assert.equal(records[0].verdict.blockingFindings.length, 1);
  assert.equal(fixInputs.length, 0);
});

test("medium and high round exhaustion block closed", async () => {
  const base = await loadAutoreviewPolicy(controlRoot);
  const mediumPolicy = structuredClone(base);
  mediumPolicy.roundBudgets.medium = 2;
  const medium = await fixture({ policy: mediumPolicy, verdicts: [findings("m1"), findings("m2")] });
  assert.equal(medium.result.code, "exhausted_medium_rounds");
  assert.equal(medium.fixInputs.length, 1);

  const highPolicy = structuredClone(base);
  highPolicy.roundBudgets.high = 1;
  const high = await fixture({ policy: highPolicy, verdicts: [clean(), findings("h1")] });
  assert.equal(high.result.code, "exhausted_high_rounds");
  assert.equal(high.fixInputs.length, 0);
});

test("either canonical review route failing blocks without implicit max fallback", async () => {
  const medium = await fixture({ verdicts: [{ routeBlocked: true }] });
  assert.equal(medium.result.code, "provider_route_blocked");
  assert.equal(medium.records.length, 1);
  assert.equal(medium.records[0].receipt.outcome, "blocked");
  assert.equal(medium.records[0].blockCode, "provider_route_blocked");

  const high = await fixture({ verdicts: [clean(), { routeBlocked: true }] });
  assert.equal(high.result.code, "provider_route_blocked");
  assert.deepEqual(high.records.map((round) => round.request.modelTier), ["medium", "high"]);
  assert.equal(high.records.at(-1).outcome, "blocked");
  assert.ok(high.records.every((round) => round.request.modelTier !== "max"));
});

test("a missing durable round receipt blocks before the protocol advances", async () => {
  const { result, records, fixInputs } = await fixture({ verdicts: [findings()], recordFailsAt: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "receipt_persistence_failed");
  assert.equal(records.length, 0);
  assert.equal(fixInputs.length, 0);
});

test("finding normalization deduplicates only identical complete findings and rejects unsafe paths", async () => {
  const policy = await loadAutoreviewPolicy(controlRoot);
  const duplicate = findings().blockingFindings[0];
  const normalized = normalizeAutoreviewVerdict({
    ...findings(),
    blockingFindings: [duplicate, structuredClone(duplicate)]
  }, policy);
  assert.equal(normalized.blockingFindings.length, 1);
  assert.equal(normalized.blockingFindings[0].details, duplicate.details);

  assert.throws(() => normalizeAutoreviewVerdict({
    ...findings(),
    blockingFindings: [{ ...duplicate, path: "../trusted/workflow.yml" }]
  }, policy), /path is unsafe/);
});

test("autofix proposals are hash-bound text edits and cannot weaken trusted controls or existing tests", async () => {
  const policy = await loadAutoreviewPolicy(controlRoot);
  const source = Buffer.from("export const value = 1;\n");
  const sourceHash = (await import("node:crypto")).createHash("sha256").update(source).digest("hex");
  const proposal = validateAutofixProposal({
    schemaVersion: 1,
    summary: "Update the reviewed source without executing it.",
    changes: [{
      path: "src/value.ts",
      expectedSha256: sourceHash,
      contentBase64: Buffer.from("export const value = 2;\n").toString("base64")
    }]
  }, { "src/value.ts": { sha256: sourceHash, isTest: false } }, policy);
  assert.equal(proposal.changes[0].content.toString("utf8"), "export const value = 2;\n");

  for (const protectedPath of [".github/workflows/ci.yml", ".GitHub/workflows/ci.yml", "package.json", "packages/api/package.json"]) {
    assert.throws(() => validateAutofixProposal({
      schemaVersion: 1,
      summary: "Weaken a protected control.",
      changes: [{ path: protectedPath, expectedSha256: "0".repeat(64), contentBase64: Buffer.from("x\n").toString("base64") }]
    }, {}, policy), /protected path/);
  }
  assert.throws(() => validateAutofixProposal({
    schemaVersion: 1,
    summary: "Rewrite an existing test.",
    changes: [{ path: "tests/value.test.ts", expectedSha256: sourceHash, contentBase64: Buffer.from("pass\n").toString("base64") }]
  }, { "tests/value.test.ts": { sha256: sourceHash, isTest: true } }, policy), /existing test file/);

  assert.throws(() => validateAutofixProposal({
    schemaVersion: 1,
    summary: "Use a Windows-reserved path.",
    changes: [{ path: "src/CON.txt", expectedSha256: "0".repeat(64), contentBase64: Buffer.from("x\n").toString("base64") }]
  }, {}, policy), /path is unsafe/);
  assert.throws(() => validateAutofixProposal({
    schemaVersion: 1,
    summary: "Return non-UTF-8 bytes.",
    changes: [{ path: "src/new.ts", expectedSha256: "0".repeat(64), contentBase64: Buffer.from([0xc3, 0x28]).toString("base64") }]
  }, {}, policy), /UTF-8 text/);
  assert.throws(() => validateAutofixProposal({
    schemaVersion: 1,
    summary: "Case-collide two writes.",
    changes: [
      { path: "src/new.ts", expectedSha256: "0".repeat(64), contentBase64: Buffer.from("a\n").toString("base64") },
      { path: "SRC/NEW.ts", expectedSha256: "0".repeat(64), contentBase64: Buffer.from("b\n").toString("base64") }
    ]
  }, {}, policy), /case-collides/);
});
