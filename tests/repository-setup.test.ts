import test from "node:test";
import assert from "node:assert/strict";

import {
  checkRepositorySetup,
  formatRepositorySetupComment,
  REPOSITORY_SETUP_COMMENT_MARKER,
  type GitHubRequester
} from "../src/repository-setup.js";

test("checkRepositorySetup returns no comment when managed setup is current", async () => {
  const report = await checkRepositorySetup(
    createRequester({
      "AGENTS.md": "# Agent Entry Point\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/workflows/dark-factory-bootstrap.yml": "name: Dark Factory Bootstrap\n",
      ".github/workflows/dark-factory-autoupdate.yml": "name: DarkFactory Auto Update\n",
      ".github/workflows/df-plan.yml": "name: DarkFactory Plan\n",
      ".github/workflows/df-follow-through.yml": "name: DarkFactory Follow Through\n",
      ".github/workflows/df-orchestrate.yml": "name: DarkFactory Orchestrate\n",
      ".github/workflows/df-work.yml": "name: DarkFactory Work\n",
      ".github/workflows/darkfactory-autoreview.yml": "name: DarkFactory Autoreview\n",
      ".github/darkfactory-autoreview.schema.json": "{}\n",
      ".github/scripts/df-autoreview.mjs": "export {}\n",
      ".github/scripts/df-model-policy.mjs": "export {}\n",
      ".github/scripts/run-darkfactory-autoreview.mjs": "export {}\n",
      ".github/scripts/dark-factory-managed-check.mjs": "#!/usr/bin/env node\n",
      ".github/scripts/df-lib.mjs": "export {}\n",
      ".github/scripts/df-enforcement.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-plan.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-orchestrate.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-sweep.mjs": "import './df-lib.mjs';\n",
      ".github/scripts/df-work.mjs": "import './df-lib.mjs';\n",
      ".darkfactory/branching-policy.md": "# Branching\n",
      ".darkfactory/autoreview-policy.json": "{}\n",
      ".darkfactory/enforcement-rules.json": "{}\n",
      ".darkfactory/labels.json": "{}\n",
      ".darkfactory/managed-repos.json": "{}\n",
      ".darkfactory/managed-repository.json": "{}\n",
      ".darkfactory/model-policy.json": "{}\n",
      ".darkfactory/orchestration.json": "{}\n",
      ".darkfactory/installer-policy.json": "{}\n"
    }),
    { owner: "marius-patrik", repo: "example", ref: "abc123" }
  );

  assert.equal(report.bootstrapPaths[0]?.status, "present");
  assert.equal(formatRepositorySetupComment(report), null);
});

test("checkRepositorySetup reports missing repository policy without a version model", async () => {
  const report = await checkRepositorySetup(
    createRequester({}),
    { owner: "marius-patrik", repo: "example", ref: "abc123" }
  );
  const comment = formatRepositorySetupComment(report);

  assert.equal(report.bootstrapPaths[0]?.status, "missing");
  assert.ok(comment?.includes(REPOSITORY_SETUP_COMMENT_MARKER));
  assert.ok(comment?.includes("AGENTS.md"));
  assert.ok(!comment?.includes(".agents/.global"));
  assert.ok(comment?.includes(".github/workflows/ci.yml"));
  assert.ok(comment?.includes(".github/workflows/dark-factory-bootstrap.yml"));
  assert.ok(comment?.includes(".github/workflows/dark-factory-autoupdate.yml"));
  assert.ok(!comment?.includes(".github/workflows/dark-factory-release.yml"));
  assert.ok(!comment?.includes(".github/workflows/df-event-forward.yml"));
  assert.ok(comment?.includes(".github/workflows/df-plan.yml"));
  assert.ok(comment?.includes(".github/workflows/df-follow-through.yml"));
  assert.ok(comment?.includes(".github/workflows/df-work.yml"));
  assert.ok(comment?.includes(".github/workflows/darkfactory-autoreview.yml"));
  assert.ok(comment?.includes(".darkfactory/enforcement-rules.json"));
  assert.ok(comment?.includes(".darkfactory/managed-repository.json"));
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
