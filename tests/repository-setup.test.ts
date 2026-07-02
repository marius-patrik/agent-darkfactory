import test from "node:test";
import assert from "node:assert/strict";

import {
  checkRepositorySetup,
  expectedManagedFolderVersion,
  formatRepositorySetupComment,
  REPOSITORY_SETUP_COMMENT_MARKER,
  type GitHubRequester
} from "../src/repository-setup.js";

test("expectedManagedFolderVersion uses the vibe-bot prefix", () => {
  assert.equal(expectedManagedFolderVersion("1.2.3"), "vibe-bot@1.2.3");
});

test("checkRepositorySetup returns no comment when managed setup is current", async () => {
  const report = await checkRepositorySetup(
    createRequester({
      ".agents/.global/VERSION": "vibe-bot@1.2.3\n",
      ".github/workflows/vibe-bot-bootstrap.yml": "name: Vibe Bot Bootstrap\n"
    }),
    { owner: "marius-patrik", repo: "example", ref: "abc123" },
    "vibe-bot@1.2.3"
  );

  assert.equal(report.versionedFolders[0]?.status, "current");
  assert.equal(report.bootstrapPaths[0]?.status, "present");
  assert.equal(formatRepositorySetupComment(report), null);
});

test("checkRepositorySetup reports stale agents and missing github bootstrap", async () => {
  const report = await checkRepositorySetup(
    createRequester({
      ".agents/.global/VERSION": "vibe-bot@0.1.0\n"
    }),
    { owner: "marius-patrik", repo: "example", ref: "abc123" },
    "vibe-bot@1.2.3"
  );
  const comment = formatRepositorySetupComment(report);

  assert.equal(report.versionedFolders[0]?.status, "stale");
  assert.equal(report.bootstrapPaths[0]?.status, "missing");
  assert.ok(comment?.includes(REPOSITORY_SETUP_COMMENT_MARKER));
  assert.ok(comment?.includes("vibe-bot@1.2.3"));
  assert.ok(comment?.includes(".agents/.global/VERSION"));
  assert.ok(comment?.includes(".github/workflows/vibe-bot-bootstrap.yml"));
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
