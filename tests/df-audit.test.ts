import assert from "node:assert/strict";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfAudit: any = await import("../.github/scripts/df-audit.mjs?unit=df-audit-test");
// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfLib: any = await import("../.github/scripts/df-lib.mjs");

const {
  DOC_PATHS,
  DOC_STALE_DAYS,
  REQUIRED_FILES,
  auditDocStaleness,
  auditHealth,
  auditSubmoduleState,
  parseGitmodules,
  resolveSubmoduleRepo
} = dfAudit;

const { auditIssueBody } = dfLib;

const parentRepo = { owner: "marius-patrik", repo: "DarkFactory" };

function mockGh(routes: Record<string, unknown>) {
  return {
    async request(method: string, path: string, _body?: unknown) {
      const key = `${method} ${path}`;
      if (key in routes) return routes[key];
      throw new Error(`Unexpected mock request: ${key}`);
    }
  };
}

function gitmodulesContent(text: string) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64")
  };
}

test("parseGitmodules returns empty array for empty content", () => {
  assert.deepEqual(parseGitmodules(""), []);
  assert.deepEqual(parseGitmodules("   \n\n"), []);
  assert.deepEqual(parseGitmodules(null), []);
});

test("parseGitmodules parses a single submodule", () => {
  const content = `[submodule "packages/darkfactory"]
  path = packages/darkfactory
  url = https://github.com/marius-patrik/DarkFactory.git
`;
  assert.deepEqual(parseGitmodules(content), [
    { name: "packages/darkfactory", path: "packages/darkfactory", url: "https://github.com/marius-patrik/DarkFactory.git" }
  ]);
});

test("parseGitmodules parses multiple submodules and ignores comments", () => {
  const content = `# Global shared code
[submodule "shared"]
  path = packages/shared
  url = ../shared.git

; additional component
[submodule "tools"]
  path = tools
  url = git@github.com:marius-patrik/tools.git
`;
  assert.deepEqual(parseGitmodules(content), [
    { name: "shared", path: "packages/shared", url: "../shared.git" },
    { name: "tools", path: "tools", url: "git@github.com:marius-patrik/tools.git" }
  ]);
});

test("resolveSubmoduleRepo handles GitHub HTTPS, SSH, and SCP-like URLs", () => {
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "https://github.com/marius-patrik/foo.git"), {
    owner: "marius-patrik",
    repo: "foo"
  });
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "https://github.com/marius-patrik/foo"), {
    owner: "marius-patrik",
    repo: "foo"
  });
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "git@github.com:marius-patrik/foo.git"), {
    owner: "marius-patrik",
    repo: "foo"
  });
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "github.com:marius-patrik/foo"), {
    owner: "marius-patrik",
    repo: "foo"
  });
});

test("resolveSubmoduleRepo resolves relative URLs against the parent repository", () => {
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "../shared.git"), { owner: "marius-patrik", repo: "shared" });
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "../../other-owner/shared.git"), {
    owner: "other-owner",
    repo: "shared"
  });
  assert.deepEqual(resolveSubmoduleRepo(parentRepo, "./sibling"), {
    owner: "DarkFactory",
    repo: "sibling"
  });
});

test("resolveSubmoduleRepo returns null for non-GitHub URLs", () => {
  assert.equal(resolveSubmoduleRepo(parentRepo, "https://gitlab.com/foo/bar.git"), null);
  assert.equal(resolveSubmoduleRepo(parentRepo, "git@gitlab.com:foo/bar.git"), null);
  assert.equal(resolveSubmoduleRepo(parentRepo, ""), null);
  assert.equal(resolveSubmoduleRepo(parentRepo, "not-a-url"), null);
});

test("auditSubmoduleState returns no findings when submodules are in sync", async () => {
  const sha = "abc123def456abc123def456abc123def456abcd";
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/contents/.gitmodules?ref=main": gitmodulesContent(
      `[submodule "shared"]\n  path = shared\n  url = ../shared.git\n`
    ),
    "GET /repos/marius-patrik/DarkFactory/contents/shared?ref=main": { type: "submodule", sha },
    "GET /repos/marius-patrik/shared": { default_branch: "main" },
    "GET /repos/marius-patrik/shared/commits/main": { sha }
  };

  const findings = await auditSubmoduleState(mockGh(routes), parentRepo, "main");
  assert.deepEqual(findings, []);
});

test("auditSubmoduleState flags a dirty submodule when recorded commit differs from HEAD", async () => {
  const recordedSha = "abc123def456abc123def456abc123def456abcd";
  const headSha = "fedcba6543210fedcba6543210fedcba6543210f";
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/contents/.gitmodules?ref=main": gitmodulesContent(
      `[submodule "shared"]\n  path = shared\n  url = ../shared.git\n`
    ),
    "GET /repos/marius-patrik/DarkFactory/contents/shared?ref=main": { type: "submodule", sha: recordedSha },
    "GET /repos/marius-patrik/shared": { default_branch: "main" },
    "GET /repos/marius-patrik/shared/commits/main": { sha: headSha }
  };

  const findings = await auditSubmoduleState(mockGh(routes), parentRepo, "main");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "git state");
  assert.match(findings[0].message, /dirty/);
  assert.match(findings[0].message, /abc123def456/);
  assert.match(findings[0].message, /fedcba654321/);
});

test("auditSubmoduleState flags a submodule declared in .gitmodules but missing from the tree", async () => {
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/contents/.gitmodules?ref=main": gitmodulesContent(
      `[submodule "shared"]\n  path = shared\n  url = ../shared.git\n`
    ),
    "GET /repos/marius-patrik/DarkFactory/contents/shared?ref=main": null,
    "GET /repos/marius-patrik/shared": { default_branch: "main" },
    "GET /repos/marius-patrik/shared/commits/main": { sha: "abc123" }
  };

  const findings = await auditSubmoduleState(mockGh(routes), parentRepo, "main");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "git state");
  assert.match(findings[0].message, /no recorded commit/);
});

test("auditSubmoduleState flags non-GitHub submodule URLs", async () => {
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/contents/.gitmodules?ref=main": gitmodulesContent(
      `[submodule "external"]\n  path = external\n  url = https://gitlab.com/foo/bar.git\n`
    )
  };

  const findings = await auditSubmoduleState(mockGh(routes), parentRepo, "main");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "git state");
  assert.match(findings[0].message, /non-GitHub URL/);
});

test("auditHealth flags failing workflow runs", async () => {
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/actions/runs?branch=main&per_page=20": {
      workflow_runs: [
        { status: "completed", conclusion: "success", name: "ci", workflow_id: 1 },
        { status: "completed", conclusion: "failure", name: "validate", workflow_id: 2 }
      ]
    }
  };

  const findings = await auditHealth(parentRepo, "main", mockGh(routes));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "health");
  assert.match(findings[0].message, /validate/);
  assert.match(findings[0].message, /failure/);
});

test("auditHealth reports no completed runs", async () => {
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/actions/runs?branch=main&per_page=20": {
      workflow_runs: [{ status: "queued", conclusion: null, name: "ci", workflow_id: 1 }]
    }
  };

  const findings = await auditHealth(parentRepo, "main", mockGh(routes));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "health");
  assert.match(findings[0].message, /No completed/);
});

test("auditHealth ignores skipped and neutral conclusions", async () => {
  const routes = {
    "GET /repos/marius-patrik/DarkFactory/actions/runs?branch=main&per_page=20": {
      workflow_runs: [
        { status: "completed", conclusion: "skipped", name: "ci", workflow_id: 1 },
        { status: "completed", conclusion: "neutral", name: "lint", workflow_id: 2 }
      ]
    }
  };

  const findings = await auditHealth(parentRepo, "main", mockGh(routes));
  assert.equal(findings.length, 0);
});

test("auditDocStaleness flags docs older than the threshold", async () => {
  const now = new Date("2026-07-07T00:00:00Z");
  const stale = new Date(now.getTime() - (DOC_STALE_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString();
  const routes: Record<string, unknown> = {};
  for (const docPath of DOC_PATHS) {
    routes[`GET /repos/marius-patrik/DarkFactory/commits?sha=main&path=${encodeURIComponent(docPath)}&per_page=1`] = [
      { commit: { committer: { date: stale } } }
    ];
  }

  const findings = await auditDocStaleness(parentRepo, { pushed_at: now.toISOString() }, "main", mockGh(routes));
  assert.equal(findings.length, DOC_PATHS.length);
  for (const finding of findings) {
    assert.equal(finding.category, "doc staleness");
  }
});

test("auditDocStaleness ignores fresh docs", async () => {
  const now = new Date("2026-07-07T00:00:00Z");
  const fresh = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const routes: Record<string, unknown> = {};
  for (const docPath of DOC_PATHS) {
    routes[`GET /repos/marius-patrik/DarkFactory/commits?sha=main&path=${encodeURIComponent(docPath)}&per_page=1`] = [
      { commit: { committer: { date: fresh } } }
    ];
  }

  const findings = await auditDocStaleness(parentRepo, { pushed_at: now.toISOString() }, "main", mockGh(routes));
  assert.deepEqual(findings, []);
});

test("auditDocStaleness returns no findings when pushed_at is missing", async () => {
  const findings = await auditDocStaleness(parentRepo, {}, "main", mockGh({}));
  assert.deepEqual(findings, []);
});

test("auditIssueBody contains expected audit sections", () => {
  const body = auditIssueBody("marius-patrik/example", [
    { category: "health", message: "CI is red" }
  ]);
  assert.match(body, /df-audit:marius-patrik-example/);
  assert.match(body, /## Findings/);
  assert.match(body, /## Acceptance Criteria/);
  assert.match(body, /## Audit Scope/);
  assert.match(body, /Git state/);
  assert.match(body, /Health/);
  assert.match(body, /Doc staleness/);
});

test("REQUIRED_FILES and DOC_PATHS are exported", () => {
  assert.ok(Array.isArray(REQUIRED_FILES));
  assert.ok(REQUIRED_FILES.includes("PRD.md"));
  assert.ok(Array.isArray(DOC_PATHS));
  assert.ok(DOC_PATHS.includes("PRD.md"));
  assert.equal(typeof DOC_STALE_DAYS, "number");
});
