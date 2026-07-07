// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ENFORCEMENT_RULES,
  evaluateEnforcementRules,
  formatEnforcementResult,
  loadEnforcementRules
} from "../.github/scripts/df-enforcement.mjs";
// Shared constants are exported from a native ESM workflow script.
import { PARKED_REPOS } from "../.github/scripts/df-lib.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoJson(filePath: string) {
  return JSON.parse(readFileSync(resolve(projectRoot, filePath), "utf8"));
}

test("enforcement rules JSON matches the canonical parked repository set", () => {
  const rules = readRepoJson(".darkfactory/enforcement-rules.json");
  const parkedRule = rules.rules.find((rule: { id: string }) => rule.id === "parked-repos-untouched");
  assert.ok(parkedRule, "parked-repos-untouched rule must exist");
  const configured = new Set((parkedRule.params?.set || []).map((repo: string) => repo.toLowerCase()));
  const canonical = [...PARKED_REPOS];
  assert.deepEqual(configured, new Set(canonical));
});

test("default enforcement rules include all built-in gates", () => {
  const ids = DEFAULT_ENFORCEMENT_RULES.rules.map((rule: { id: string }) => rule.id);

  assert.ok(ids.includes("never-merge-red"));
  assert.ok(ids.includes("no-force-push"));
  assert.ok(ids.includes("no-admin-bypass"));
  assert.ok(ids.includes("secrets-never-logged"));
  assert.ok(ids.includes("parked-repos-untouched"));
  assert.ok(ids.includes("work-PRs-target-dev"));
});

test("loadEnforcementRules returns defaults when the repo has no rules file", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const gh = {
    async request(method: string, path: string) {
      calls.push({ method, path });
      if (method === "GET" && path === "/repos/marius-patrik/example/contents/.darkfactory/enforcement-rules.json") {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }
  };

  const rules = await loadEnforcementRules(gh, { owner: "marius-patrik", repo: "example" });
  assert.equal(rules.source, "default");
  assert.ok(rules.rules.length > 0);
  assert.ok(calls.some((call) => call.path.includes("enforcement-rules.json")));
});

test("loadEnforcementRules loads repository-specific rules", async () => {
  const customRules = {
    schemaVersion: 1,
    rules: [
      {
        id: "custom-rule",
        enabled: true,
        scope: ["dispatch"],
        gate: "policy_assertion",
        message: "Custom policy."
      }
    ]
  };
  const gh = {
    async request(method: string, path: string) {
      if (method === "GET" && path === "/repos/marius-patrik/example/contents/.darkfactory/enforcement-rules.json") {
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(customRules), "utf8").toString("base64")
        };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }
  };

  const rules = await loadEnforcementRules(gh, { owner: "marius-patrik", repo: "example" });
  assert.equal(rules.source, ".darkfactory/enforcement-rules.json");
  assert.deepEqual(rules.rules.map((rule: { id: string }) => rule.id), ["custom-rule"]);
});

test("evaluateEnforcementRules passes dispatch rules for a valid work target", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "dispatch", {
    repository: { owner: "marius-patrik", repo: "example" },
    baseBranch: "dev",
    defaultBranch: "main"
  });

  assert.equal(result.passed, true);
  assert.ok(result.results.some((r: { id: string; status: string }) => r.id === "work-PRs-target-dev" && r.status === "pass"));
  assert.ok(result.results.some((r: { id: string; status: string }) => r.id === "parked-repos-untouched" && r.status === "pass"));
});

test("evaluateEnforcementRules blocks dispatch to parked repositories", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "dispatch", {
    repository: { owner: "marius-patrik", repo: "fabrica" },
    baseBranch: "dev",
    defaultBranch: "main"
  });

  assert.equal(result.passed, false);
  const failure = result.results.find((r: { id: string; status: string }) => r.id === "parked-repos-untouched");
  assert.equal(failure?.status, "fail");
});

test("evaluateEnforcementRules blocks dispatch when work PR does not target dev", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "dispatch", {
    repository: { owner: "marius-patrik", repo: "example" },
    baseBranch: "feature",
    defaultBranch: "main"
  });

  assert.equal(result.passed, false);
  const failure = result.results.find((r: { id: string; status: string }) => r.id === "work-PRs-target-dev");
  assert.equal(failure?.status, "fail");
});

test("evaluateEnforcementRules passes merge gate when all required checks are green", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "merge", {
    repository: { owner: "marius-patrik", repo: "example" },
    pull: { baseRefName: "dev" },
    requiredContexts: ["CI"],
    statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]
  });

  assert.equal(result.passed, true);
  const neverMergeRed = result.results.find((r: { id: string; status: string }) => r.id === "never-merge-red");
  assert.equal(neverMergeRed?.status, "pass");
});

test("evaluateEnforcementRules fails merge gate when a required check is red", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "merge", {
    repository: { owner: "marius-patrik", repo: "example" },
    pull: { baseRefName: "dev" },
    requiredContexts: ["CI"],
    statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "FAILURE" }]
  });

  assert.equal(result.passed, false);
  const neverMergeRed = result.results.find((r: { id: string; status: string }) => r.id === "never-merge-red");
  assert.equal(neverMergeRed?.status, "fail");
});

test("evaluateEnforcementRules fails merge gate when a required context is missing", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "merge", {
    repository: { owner: "marius-patrik", repo: "example" },
    pull: { baseRefName: "dev" },
    requiredContexts: ["CI", "Codex Review"],
    statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]
  });

  assert.equal(result.passed, false);
  const neverMergeRed = result.results.find((r: { id: string; status: string }) => r.id === "never-merge-red");
  assert.equal(neverMergeRed?.status, "fail");
});

test("formatEnforcementResult returns null when all rules pass", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "dispatch", {
    repository: { owner: "marius-patrik", repo: "example" },
    baseBranch: "dev",
    defaultBranch: "main"
  });

  assert.equal(formatEnforcementResult(result), null);
});

test("formatEnforcementResult lists failed rules", () => {
  const result = evaluateEnforcementRules(DEFAULT_ENFORCEMENT_RULES, "dispatch", {
    repository: { owner: "marius-patrik", repo: "fabrica" },
    baseBranch: "dev",
    defaultBranch: "main"
  });

  const comment = formatEnforcementResult(result);
  assert.ok(comment);
  assert.match(comment, /parked-repos-untouched/);
  assert.match(comment, /Scope: `dispatch`/);
});
