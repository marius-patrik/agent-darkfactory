import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfEnforcement: any = await import("../.github/scripts/df-enforcement.mjs");

const {
  BUILTIN_RULES,
  ENFORCEMENT_RULES_PATH,
  defaultEnforcementRules,
  evaluateEnforcementRules,
  listRegisteredEnforcementRules,
  loadEnforcementRules,
  normalizeEnforcementRules,
  registerEnforcementRule
} = dfEnforcement;

function mockGh(routes: Record<string, unknown>) {
  return {
    async request(method: string, path: string, _body?: unknown) {
      const key = `${method} ${path}`;
      if (key in routes) return routes[key];
      throw new Error(`Unexpected mock request: ${key}`);
    }
  };
}

test("default enforcement rules include all built-in rules", () => {
  const rules = defaultEnforcementRules();
  assert.equal(rules.schemaVersion, 1);
  assert.deepEqual(rules.rules.map((rule: { id: string }) => rule.id), BUILTIN_RULES);
  for (const rule of rules.rules) {
    assert.equal(rule.enabled, true);
    assert.ok(typeof rule.description === "string" && rule.description.length > 0);
  }
});

test("loadEnforcementRules fails closed when file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-enforcement-"));
  try {
    await assert.rejects(loadEnforcementRules(root), /Failed to read required JSON file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadEnforcementRules fails closed on malformed JSON and schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-enforcement-"));
  try {
    await mkdir(join(root, ".darkfactory"), { recursive: true });
    await writeFile(join(root, ENFORCEMENT_RULES_PATH), "{");
    await assert.rejects(loadEnforcementRules(root), /Invalid JSON/);

    await writeFile(join(root, ENFORCEMENT_RULES_PATH), JSON.stringify({ schemaVersion: 2, rules: [] }));
    await assert.rejects(loadEnforcementRules(root), /schemaVersion 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadEnforcementRules reads a custom rules file", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-enforcement-"));
  try {
    const custom = {
      schemaVersion: 1,
      rules: [
        { id: "never-merge-red", enabled: false, severity: "block" },
        { id: "parked-repos-untouched", enabled: true, severity: "warn" }
      ]
    };
    await mkdir(join(root, ".darkfactory"), { recursive: true });
    await writeFile(join(root, ENFORCEMENT_RULES_PATH), JSON.stringify(custom));
    const rules = await loadEnforcementRules(root);
    const neverMergeRed = rules.rules.find((rule: { id: string }) => rule.id === "never-merge-red");
    const parked = rules.rules.find((rule: { id: string }) => rule.id === "parked-repos-untouched");
    assert.equal(neverMergeRed.enabled, false);
    assert.equal(parked.severity, "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizeEnforcementRules rejects malformed input", () => {
  assert.throws(() => normalizeEnforcementRules(null), /rules array/);
});

test("parked-repos-untouched blocks parked repositories", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "parked-repos-untouched", enabled: true, severity: "block" }]
  });

  const blocked = await evaluateEnforcementRules(rules, {
    repository: { owner: "marius-patrik", repo: "fabrica" }
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.findings[0].rule, "parked-repos-untouched");
  assert.match(blocked.findings[0].message, /parked/);

  const allowed = await evaluateEnforcementRules(rules, {
    repository: { owner: "marius-patrik", repo: "DarkFactory" }
  });

  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.findings, []);
});

test("work-PRs-target-dev blocks PRs targeting the wrong branch", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "work-PRs-target-dev", enabled: true, severity: "block", parameters: { defaultBranch: "dev" } }]
  });

  const blocked = await evaluateEnforcementRules(rules, { baseBranch: "main" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.findings[0].message, /main/);

  const allowed = await evaluateEnforcementRules(rules, { baseBranch: "dev" });
  assert.equal(allowed.ok, true);
});

test("never-merge-red blocks when required checks are missing or red", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "never-merge-red", enabled: true, severity: "block" }]
  });

  const blocked = await evaluateEnforcementRules(rules, {
    requiredContexts: ["ci"],
    statusCheckRollup: []
  });
  assert.equal(blocked.ok, false);

  const allowed = await evaluateEnforcementRules(rules, {
    requiredContexts: ["ci"],
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
  });
  assert.equal(allowed.ok, true);
});

test("no-force-push detects head_ref_force_pushed timeline events", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "no-force-push", enabled: true, severity: "block" }]
  });
  const gh = mockGh({
    "GET /repos/marius-patrik/example/issues/42/timeline?per_page=100&page=1": [
      { event: "head_ref_force_pushed", created_at: "2026-07-07T00:00:00Z" }
    ]
  });

  const blocked = await evaluateEnforcementRules(rules, {
    gh,
    repository: { owner: "marius-patrik", repo: "example" },
    pull: { number: 42 }
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.findings[0].message, /force-pushed/);

  const allowed = await evaluateEnforcementRules(rules, {
    gh: mockGh({ "GET /repos/marius-patrik/example/issues/42/timeline?per_page=100&page=1": [] }),
    repository: { owner: "marius-patrik", repo: "example" },
    pull: { number: 42 }
  });
  assert.equal(allowed.ok, true);
});

test("no-admin-bypass blocks merge actions with admin or bypass flags", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "no-admin-bypass", enabled: true, severity: "block" }]
  });

  const blocked = await evaluateEnforcementRules(rules, {
    mergeAction: { admin: true }
  });
  assert.equal(blocked.ok, false);

  const allowed = await evaluateEnforcementRules(rules, {
    mergeAction: { merge_method: "squash" }
  });
  assert.equal(allowed.ok, true);
});

test("secrets-never-logged warns when token appears in logged output", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "secrets-never-logged", enabled: true, severity: "warn" }]
  });

  const warned = await evaluateEnforcementRules(rules, {
    token: "secret-token",
    loggedOutput: "something secret-token leaked"
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.findings[0].severity, "warn");
  assert.match(warned.findings[0].message, /unredacted/);

  const clean = await evaluateEnforcementRules(rules, {
    token: "secret-token",
    loggedOutput: "something *** leaked"
  });
  assert.equal(clean.findings.length, 0);
});

test("disabled rules are skipped", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "parked-repos-untouched", enabled: false, severity: "block" }]
  });

  const result = await evaluateEnforcementRules(rules, {
    repository: { owner: "marius-patrik", repo: "fabrica" }
  });
  assert.equal(result.ok, true);
});

test("unknown rules emit a finding", async () => {
  const rules = normalizeEnforcementRules({
    rules: [{ id: "custom-unknown-rule", enabled: true, severity: "warn" }]
  });

  const result = await evaluateEnforcementRules(rules, {});
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].rule, "custom-unknown-rule");
  assert.match(result.findings[0].message, /No evaluator registered/);
});

test("rule registry can be extended at runtime", async () => {
  registerEnforcementRule("custom-runtime-rule", (_rule: unknown, context: { value?: number }) => {
    if (context.value === 42) {
      return { message: "value is 42" };
    }
    return null;
  });

  const rules = normalizeEnforcementRules({
    rules: [{ id: "custom-runtime-rule", enabled: true, severity: "block" }]
  });

  assert.ok(listRegisteredEnforcementRules().includes("custom-runtime-rule"));

  const blocked = await evaluateEnforcementRules(rules, { value: 42 });
  assert.equal(blocked.ok, false);

  const allowed = await evaluateEnforcementRules(rules, { value: 1 });
  assert.equal(allowed.ok, true);
});
