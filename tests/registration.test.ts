import assert from "node:assert/strict";
import test from "node:test";

import { convergeManagedRegistration, MANAGED_REGISTRY_PATH } from "../src/registration.js";

const SHA = "a".repeat(40);

test("managed registration is a no-op when canonical source already declares the target active", async () => {
  const calls: string[] = [];
  const github = fixtureGithub(calls, {
    repositories: { "marius-patrik/example": { state: "active", kind: "code" } }
  });
  const result = await convergeManagedRegistration(github, "MARIUS-PATRIK/EXAMPLE");
  assert.equal(result.sourceActive, true);
  assert.equal(result.receipt.status, "current");
  assert.deepEqual(calls, ["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/contents/{path}"]);
});

test("managed registration opens one reviewed source-policy PR and preserves existing entries", async () => {
  const calls: string[] = [];
  let written: Record<string, unknown> | null = null;
  const github = fixtureGithub(calls, {
    repositories: { "marius-patrik/Andromeda": { state: "active" } },
    onWrite(parameters) { written = parameters; }
  });
  const result = await convergeManagedRegistration(github, "marius-patrik/Example");
  assert.equal(result.sourceActive, false);
  assert.equal(result.receipt.status, "applied");
  assert.match(result.receipt.detail, /pull\/77$/);
  assert.ok(written);
  const writtenParameters = written as Record<string, unknown>;
  const next = JSON.parse(Buffer.from(String(writtenParameters.content), "base64").toString("utf8"));
  assert.deepEqual(next.repositories["marius-patrik/Andromeda"], { state: "active" });
  assert.equal(next.repositories["marius-patrik/example"].state, "active");
  assert.equal(next.repositories["marius-patrik/example"].kind, "code");
});

test("managed registration resumes branch-only partial mutations and creates the missing pull request", async () => {
  for (const [label, branchHead, branchContent] of [
    ["branch-created", SHA, undefined],
    ["content-written", "b".repeat(40), expectedRegistryContent({
      "marius-patrik/Andromeda": { state: "active" },
      "marius-patrik/example": {
        state: "active",
        kind: "code",
        note: "Managed code repository admitted through the reviewed df setup registration lane."
      }
    })]
  ] as const) {
    const calls: string[] = [];
    const result = await convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      branchExists: true,
      branchHead,
      branchContent
    }), "marius-patrik/example");
    assert.equal(result.receipt.status, "applied", label);
    assert.equal(calls.includes("POST /repos/{owner}/{repo}/git/refs"), false, label);
    assert.equal(calls.includes("POST /repos/{owner}/{repo}/pulls"), true, label);
    assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), label === "branch-created", label);
  }
});

test("managed registration preserves a predictable branch carrying unknown work", async () => {
  const calls: string[] = [];
  await assert.rejects(convergeManagedRegistration(fixtureGithub(calls, {
    repositories: {},
    branchExists: true,
    branchHead: "b".repeat(40),
    comparisonFiles: [MANAGED_REGISTRY_PATH, "README.md"]
  }), "marius-patrik/example"), /unknown or stale work/);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), false);
  assert.equal(calls.includes("POST /repos/{owner}/{repo}/pulls"), false);
});

test("managed registration refuses parked targets and competing pull-request content", async () => {
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub([], { repositories: { "marius-patrik/example": { state: "parked" } } }), "marius-patrik/example"),
    /owner lifecycle brake/
  );
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub([], {
      repositories: {},
      existingPull: true,
      proposedRepositories: { "marius-patrik/other": { state: "active" } }
    }), "marius-patrik/example"),
    /does not carry the exact canonical registry content/
  );
});

function fixtureGithub(
  calls: string[],
  options: {
    repositories: Record<string, unknown>;
    proposedRepositories?: Record<string, unknown>;
    existingPull?: boolean;
    branchExists?: boolean;
    branchHead?: string;
    branchContent?: string;
    comparisonFiles?: string[];
    onWrite?: (parameters: Record<string, unknown>) => void;
  }
) {
  const content = (repositories: Record<string, unknown>, raw?: string) => ({
    data: {
      sha: SHA,
      encoding: "base64",
      content: Buffer.from(raw ?? JSON.stringify({ schemaVersion: 1, description: "fixture", repositories })).toString("base64")
    }
  });
  return {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}") return { data: { private: true, default_branch: "main", archived: false, disabled: false } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        assert.equal(parameters.path, MANAGED_REGISTRY_PATH);
        return parameters.ref === "main"
          ? content(options.repositories)
          : content(options.proposedRepositories || options.repositories, options.branchContent);
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: options.existingPull ? [{ html_url: "https://github.com/marius-patrik/Andromeda-data/pull/70" }] : [] };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (parameters.ref === "heads/main") return { data: { object: { sha: SHA } } };
        if (options.branchExists || options.existingPull) return { data: { object: { sha: options.branchHead || "b".repeat(40) } } };
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") return {
        data: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          files: (options.comparisonFiles || [MANAGED_REGISTRY_PATH]).map((filename) => ({ filename }))
        }
      };
      if (route === "POST /repos/{owner}/{repo}/git/refs") return { data: {} };
      if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
        options.onWrite?.(parameters);
        return { data: {} };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") return { data: { html_url: "https://github.com/marius-patrik/Andromeda-data/pull/77" } };
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function expectedRegistryContent(repositories: Record<string, unknown>): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    description: "fixture",
    repositories: Object.fromEntries(Object.entries(repositories).sort(([a], [b]) => a.localeCompare(b)))
  }, null, 2)}\n`;
}
