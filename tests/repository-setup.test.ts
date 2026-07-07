import test from "node:test";
import assert from "node:assert/strict";

import {
  checkRepositorySetup,
  expectedManagedFolderVersion,
  formatRepositorySetupComment,
  REPOSITORY_SETUP_COMMENT_MARKER,
  type GitHubRequester
} from "../src/repository-setup.js";

test("expectedManagedFolderVersion uses the agent-darkfactory prefix", () => {
  assert.equal(expectedManagedFolderVersion("1.2.3"), "agent-darkfactory@1.2.3");
});

test("checkRepositorySetup returns no comment when managed setup is current", async () => {
  const report = await checkRepositorySetup(
    createRequester({
      "AGENTS.md": "# Agent Entry Point\n",
      ".agents/.global/VERSION": "agent-darkfactory@1.2.3\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/workflows/dark-factory-bootstrap.yml": "name: Dark Factory Bootstrap\n",
      ".github/workflows/dark-factory-autoupdate.yml": "name: DarkFactory Auto Update\n",
      ".github/workflows/dark-factory-release.yml": "name: DarkFactory Release\n",
      ".github/workflows/df-plan.yml": "name: DarkFactory Plan\n",
      ".github/workflows/df-follow-through.yml": "name: DarkFactory Follow Through\n",
      ".github/workflows/df-orchestrate.yml": "name: DarkFactory Orchestrate\n",
      ".github/workflows/df-work.yml": "name: DarkFactory Work\n",
      ".github/workflows/codex-review.yml": "name: Codex Review\n",
      ".github/codex-review.Dockerfile": "FROM node:22-bookworm-slim\n",
      ".github/codex-review.schema.json": "{}\n",
      ".github/scripts/run-codex-review.sh": "#!/usr/bin/env bash\n",
      ".github/scripts/validate-codex-review.mjs": "#!/usr/bin/env node\n",
      ".github/scripts/dark-factory-release-check.mjs": "#!/usr/bin/env node\n",
      ".github/scripts/df-lib.mjs": "export {}\n",
      ".github/scripts/df-plan.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-orchestrate.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-sweep.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-work.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-enforcement.mjs": "export {}\n",
      ".darkfactory/branching-policy.md": "# Branching\n",
      ".darkfactory/labels.json": "{}\n",
      ".darkfactory/managed-repository.json": "{}\n",
      ".darkfactory/enforcement-rules.json": "{}\n",
      ".darkfactory/installer-policy.json": "{}\n",
      ".darkfactory/release-conventions.md": "# Release\n",
      ".darkfactory/release-policy.json": "{}\n"
    }),
    { owner: "marius-patrik", repo: "example", ref: "abc123" },
    "agent-darkfactory@1.2.3"
  );

  assert.equal(report.versionedFolders[0]?.status, "current");
  assert.equal(report.bootstrapPaths[0]?.status, "present");
  assert.equal(formatRepositorySetupComment(report), null);
});

test("checkRepositorySetup reports stale agents and missing github bootstrap", async () => {
  const report = await checkRepositorySetup(
    createRequester({
      ".agents/.global/VERSION": "agent-darkfactory@0.1.0\n"
    }),
    { owner: "marius-patrik", repo: "example", ref: "abc123" },
    "agent-darkfactory@1.2.3"
  );
  const comment = formatRepositorySetupComment(report);

  assert.equal(report.versionedFolders[0]?.status, "stale");
  assert.equal(report.bootstrapPaths[0]?.status, "missing");
  assert.ok(comment?.includes(REPOSITORY_SETUP_COMMENT_MARKER));
  assert.ok(comment?.includes("agent-darkfactory@1.2.3"));
  assert.ok(comment?.includes("AGENTS.md"));
  assert.ok(comment?.includes(".agents/.global/VERSION"));
  assert.ok(comment?.includes(".github/workflows/ci.yml"));
  assert.ok(comment?.includes(".github/workflows/dark-factory-bootstrap.yml"));
  assert.ok(comment?.includes(".github/workflows/dark-factory-autoupdate.yml"));
  assert.ok(comment?.includes(".github/workflows/dark-factory-release.yml"));
  assert.ok(!comment?.includes(".github/workflows/df-event-forward.yml"));
  assert.ok(comment?.includes(".github/workflows/df-plan.yml"));
  assert.ok(comment?.includes(".github/workflows/df-follow-through.yml"));
  assert.ok(comment?.includes(".github/workflows/df-work.yml"));
  assert.ok(comment?.includes(".github/workflows/codex-review.yml"));
  assert.ok(comment?.includes(".github/scripts/validate-codex-review.mjs"));
  assert.ok(comment?.includes(".github/scripts/df-enforcement.mjs"));
  assert.ok(comment?.includes(".darkfactory/managed-repository.json"));
  assert.ok(comment?.includes(".darkfactory/enforcement-rules.json"));
});

function createRequester(files: Record<string, string>): GitHubRequester {
  return {
    async request(route, parameters) {
      assert.equal(route, "GET /repos/{owner}/{repo}/contents/{path}");
      assert.equal(parameters.owner, "marius-patrik");
      assert.equal(parameters.repo, "example");
      assert.equal(parameters.ref, "abc123");

      const path = parameters.path;

      if (typeof path !== "string" || !(path in files)) {
        throw { status: 404 };
      }

      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(files[path] ?? "", "utf8").toString("base64")
        }
      };
    }
  };
}
