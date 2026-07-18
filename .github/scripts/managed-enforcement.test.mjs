import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ciWorkflowPath = ".github/workflows/ci.yml";
const reviewWorkflowPath = ".github/workflows/darkfactory-autoreview.yml";

function step(workflow, name) {
  return workflow.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s{6}- name:|$)`))?.[0] ?? "";
}

test("managed Validate provisions Go and uv before dependency installation", async () => {
  const workflow = await readFile(ciWorkflowPath, "utf8");
  const go = workflow.indexOf("uses: actions/setup-go@v6");
  const uv = workflow.indexOf("uses: astral-sh/setup-uv@v8.3.2");
  const install = workflow.indexOf("- name: Install dependencies");
  assert.ok(go >= 0, "managed Validate must provision Go");
  assert.ok(uv >= 0, "managed Validate must provision uv");
  assert.match(workflow, /cache-dependency-path: packages\/core\/contracts-go\/go\.sum/);
  assert.ok(go < install && uv < install, "language runtimes must be ready before install and validation");
});

test("monorepo validation uses the uv CLI without a cross-repository go.work", async () => {
  const commands = await readFile(".agents/.project/COMMANDS.md", "utf8");
  assert.doesNotMatch(commands, /python(?:3)?\s+-m\s+uv/);
  assert.match(commands, /\buv sync --frozen\b/);
  assert.equal(existsSync("go.work"), false);
  assert.equal(existsSync("packages/core/contracts-go/go.mod"), true);
});

test("Autoreview loads provider-agnostic control from protected DarkFactory main", async () => {
  const workflow = await readFile(reviewWorkflowPath, "utf8");
  const checkout = step(workflow, "Checkout protected DarkFactory control runtime");
  assert.match(workflow, /pull_request_target:/);
  assert.match(checkout, /repository: marius-patrik\/DarkFactory/);
  assert.match(checkout, /ref: main/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(workflow, /run-darkfactory-autoreview\.mjs/);
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON|KIMI_AUTH_JSON|codex-review|run-kimi-review/i);
});

test("Autoreview validates canonical Agent OS before the bounded review protocol", async () => {
  const workflow = await readFile(reviewWorkflowPath, "utf8");
  const verify = step(workflow, "Verify canonical Agent OS");
  const review = step(workflow, "Run bounded medium-to-clean and high confirmation protocol");
  assert.match(verify, /AGENTS_HOME/);
  assert.match(verify, /agents\.ps1/);
  assert.match(verify, /state doctor --json/);
  assert.match(review, /DF_EXPECTED_BASE_SHA/);
  assert.match(review, /DF_EXPECTED_HEAD_SHA/);
  assert.match(review, /DF_CONTROL_REVISION/);
});

test("legacy provider-specific review assets are absent and no longer required", async () => {
  const legacyPaths = [
    ".github/workflows/codex-review.yml",
    ".github/codex-review.Dockerfile",
    ".github/codex-review.schema.json",
    ".github/scripts/run-codex-review.sh",
    ".github/scripts/run-kimi-review.mjs",
    ".github/scripts/run-kimi-review.test.mjs",
  ];
  for (const legacyPath of legacyPaths) assert.equal(existsSync(legacyPath), false, legacyPath);

  const managed = JSON.parse(await readFile(".darkfactory/managed-repository.json", "utf8"));
  assert.deepEqual(managed.requiredSecrets, ["DARK_FACTORY_APP_ID", "DARK_FACTORY_PRIVATE_KEY"]);
  assert.ok(managed.requiredFiles.includes(reviewWorkflowPath));
  assert.ok(legacyPaths.every((legacyPath) => managed.removedFiles.includes(legacyPath)));
});

test("documented branch policy matches the enforced check names", async () => {
  const policy = await readFile(".darkfactory/branching-policy.md", "utf8");
  assert.match(policy, /Both `dev` and `main` use strict GitHub-Actions-bound branch protection with\s+`Validate` and `DarkFactory Autoreview` required/);
  assert.match(policy, /independent schema-valid\s+clean high confirmation/);
  assert.match(policy, /Force pushes and branch deletion are disabled/);
  assert.match(policy, /Administrator enforcement remains disabled/);
});

test("Andromeda-data posture records the compensating control without choosing billing or visibility", async () => {
  const posture = await readFile("docs/managed-enforcement.md", "utf8");
  assert.match(posture, /private repository/);
  assert.match(posture, /Upgrade to GitHub Pro or make this repository public/);
  assert.match(posture, /authenticated encrypted event\s+bundles/);
  assert.match(posture, /No billing or visibility change was made/);
});
