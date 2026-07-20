import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

// @ts-ignore Workflow policy helpers are native ESM, not built TypeScript modules.
const autoreviewModule: any = await import("../.github/scripts/df-autoreview.mjs");
// @ts-ignore Workflow entrypoint helpers are native ESM, not built TypeScript modules.
const autoreviewRunnerModule: any = await import("../.github/scripts/run-darkfactory-autoreview.mjs");

const {
  buildChangedTreeEvidence,
  parseChangedPaths
} = autoreviewRunnerModule;
const { assertAutofixPathsEligible, loadAutoreviewPolicy, validateAutofixProposal } = autoreviewModule;
const controlRoot = fileURLToPath(new URL("../", import.meta.url));

function changedEvidence(names: Buffer, baseEntries: any[], headEntries: any[]) {
  const tree = buildChangedTreeEvidence(parseChangedPaths(names), baseEntries, headEntries);
  const files: Record<string, unknown> = {};
  const reviewedFiles = tree.entries.map((evidence: any) => {
    if (evidence.autofixEligible) files[evidence.path] = { sha256: "unread" };
    return evidence;
  });
  return { files, reviewedFiles, autofixDeniedPaths: tree.autofixDeniedPaths };
}

test("gitlink pointer changes preserve exact base and head OIDs and stay out of autofix", () => {
  const path = "modules/darkfactory";
  const baseOid = "a".repeat(40);
  const headOid = "b".repeat(40);
  const result = changedEvidence(
    Buffer.from(`${path}\0`),
    [{ mode: "160000", type: "commit", oid: baseOid, path }],
    [{ mode: "160000", type: "commit", oid: headOid, path }]
  );

  assert.deepEqual(result.files, {});
  assert.deepEqual(result.reviewedFiles, [{
    path,
    kind: "gitlink",
    deleted: false,
    mode: "160000",
    oid: headOid,
    baseOid,
    headOid,
    replacementMode: null,
    replacementOid: null,
    contentKind: "none",
    autofixEligible: false,
    sha256: null,
    content: null
  }]);
});

test("gitlink renames preserve both exact paths and OIDs and keep both sides out of autofix", () => {
  const oldPath = "modules/old-name";
  const newPath = "modules/new-name";
  const baseOid = "c".repeat(40);
  const headOid = "d".repeat(40);
  const result = changedEvidence(
    Buffer.from(`${oldPath}\0${newPath}\0`),
    [{ mode: "160000", type: "commit", oid: baseOid, path: oldPath }],
    [{ mode: "160000", type: "commit", oid: headOid, path: newPath }]
  );

  assert.deepEqual(result.files, {});
  assert.deepEqual(result.reviewedFiles.map((entry: any) => ({
    path: entry.path,
    deleted: entry.deleted,
    oid: entry.oid,
    baseOid: entry.baseOid,
    headOid: entry.headOid,
    autofixEligible: entry.autofixEligible
  })), [
    { path: oldPath, deleted: true, oid: baseOid, baseOid, headOid: null, autofixEligible: false },
    { path: newPath, deleted: false, oid: headOid, baseOid: null, headOid, autofixEligible: false }
  ]);
});

test("every base or head gitlink path rejects zero-hash autofix at validation and mutation", async () => {
  const policy = await loadAutoreviewPolicy(controlRoot);
  const oldPath = "modules/old-name";
  const newPath = "modules/new-name";
  const baseOid = "e".repeat(40);
  const headOid = "f".repeat(40);
  const deletion = changedEvidence(
    Buffer.from(`${oldPath}\0`),
    [{ mode: "160000", type: "commit", oid: baseOid, path: oldPath }],
    []
  );
  const rename = changedEvidence(
    Buffer.from(`${oldPath}\0${newPath}\0`),
    [{ mode: "160000", type: "commit", oid: baseOid, path: oldPath }],
    [{ mode: "160000", type: "commit", oid: headOid, path: newPath }]
  );
  const unchanged = changedEvidence(
    Buffer.alloc(0),
    [{ mode: "160000", type: "commit", oid: baseOid, path: oldPath }],
    [{ mode: "160000", type: "commit", oid: baseOid, path: oldPath }]
  );

  for (const [path, deniedPaths] of [
    [oldPath, deletion.autofixDeniedPaths],
    [oldPath, rename.autofixDeniedPaths],
    [newPath, rename.autofixDeniedPaths],
    [oldPath, unchanged.autofixDeniedPaths]
  ] as const) {
    for (const candidate of [path, `${path}/file.txt`]) {
      const proposal = {
        schemaVersion: 1,
        summary: "Attempt to recreate an ineligible gitlink namespace.",
        changes: [{
          path: candidate,
          expectedSha256: "0".repeat(64),
          contentBase64: Buffer.from("replacement\n").toString("base64")
        }]
      };
      assert.throws(
        () => validateAutofixProposal(proposal, {}, policy, deniedPaths),
        /ineligible changed path/
      );
      assert.throws(
        () => assertAutofixPathsEligible([candidate], deniedPaths),
        /ineligible changed path/
      );
    }
  }
});
