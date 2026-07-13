import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { javascriptPackageVersionIssues } from "./verify-single-product-versions.mjs";

test("ordinary future JavaScript workspaces cannot drift from the product version", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "andromeda-product-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages", "future-client"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(
    path.join(root, "packages", "future-client", "package.json"),
    JSON.stringify({ version: "9.9.9" }),
  );

  assert.deepEqual(
    javascriptPackageVersionIssues(
      root,
      ["package.json", "packages/future-client/package.json", "packages/future-client/agent.package.json"],
      "0.1.0",
    ),
    ["JavaScript package version drift in packages/future-client/package.json: 9.9.9 != 0.1.0"],
  );
});
