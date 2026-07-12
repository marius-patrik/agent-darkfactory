import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseCredential, parseReview, persistRefreshedCredential, requestReview, shouldTakeOver } from "./run-kimi-review.mjs";

const validReview = {
  approved: true,
  summary: "No blocking findings.",
  blocking_findings: [],
  non_blocking_notes: ["Keep the focused test."],
};

test("parses fenced review JSON into the canonical result shape", () => {
  const review = parseReview(`\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\``);
  assert.equal(review.approved, true);
  assert.match(review.summary, /^Kimi quota-takeover review:/);
  assert.deepEqual(Object.keys(review), ["approved", "summary", "blocking_findings", "non_blocking_notes"]);
});

test("blocking findings always force a failed normalized verdict", () => {
  const review = parseReview(JSON.stringify({ ...validReview, approved: true, blocking_findings: ["unsafe"] }));
  assert.equal(review.approved, false);
  assert.deepEqual(review.blocking_findings, ["unsafe"]);
});

test("takeover dispatch uses only the trusted automation exit code", () => {
  assert.equal(shouldTakeOver(42), true);
  assert.equal(shouldTakeOver(0), false);
  assert.equal(shouldTakeOver(1), false);
  assert.equal(shouldTakeOver("42"), true);
});

test("persists rotated credentials through an in-memory gh stdin pipe", async () => {
  let invocation;
  let piped = "";
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      piped += chunk;
    });
    child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
    return child;
  };
  const credential = { access_token: "fresh", refresh_token: "rotated" };
  await persistRefreshedCredential(credential, { GH_TOKEN: "app-token", GITHUB_REPOSITORY: "owner/repo" }, spawnImpl);
  assert.equal(invocation.command, "gh");
  assert.deepEqual(invocation.args, ["secret", "set", "KIMI_AUTH_JSON", "--repo", "owner/repo"]);
  assert.deepEqual(JSON.parse(piped), credential);
});

test("a valid primary changes-required review wins despite nonzero Codex exit", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-review-primary-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "codex-home");
  const context = path.join(root, "context");
  const output = path.join(root, "review.json");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(context)]);
  await writeFile(path.join(home, "auth.json"), "{}\n");
  await writeFile(path.join(context, "AGENTS.md"), "rules\n");
  await writeFile(path.join(context, "linked-issues.md"), "issue\n");
  await writeFile(
    path.join(bin, "codex"),
    "#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"--output-last-message\" ]; then shift; out=$1; fi; shift; done\nprintf '%s\\n' '{\"approved\":false,\"summary\":\"real finding\",\"blocking_findings\":[\"block\"],\"non_blocking_notes\":[]}' > \"$out\"\nexit 1\n",
    { mode: 0o755 },
  );
  try {
    const result = spawnSync("bash", [".github/scripts/run-codex-review.sh"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        CODEX_HOME: home,
        REVIEW_CONTEXT_DIR: context,
        REVIEW_OUTPUT: output,
        BASE_BRANCH: "dev",
        BASE_REF: "HEAD",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      approved: false,
      summary: "real finding",
      blocking_findings: ["block"],
      non_blocking_notes: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed credential envelopes", () => {
  assert.throws(() => parseCredential('{"refresh_token":"secret"}'), /access_token/);
  assert.equal(parseCredential('{"kimi-code":{"access_token":"token"}}').access_token, "token");
});

test("uses the review API without placing credentials in model input", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const review = await requestReview({
    prompt: "review this diff",
    credential: { access_token: "top-secret", expires_at: Math.floor(Date.now() / 1000) + 3600 },
    fetchImpl,
    env: {},
  });
  assert.equal(review.approved, true);
  assert.equal(request.init.headers.authorization, "Bearer top-secret");
  assert.doesNotMatch(request.init.body, /top-secret/);
  assert.match(request.init.body, /review this diff/);
  assert.equal(JSON.parse(request.init.body).temperature, 1);
});

test("refreshes an expired OAuth token before the review request", async () => {
  const calls = [];
  let rotated;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }), { status: 200 });
  };
  await requestReview({
    prompt: "review",
    credential: { access_token: "expired", refresh_token: "refresh", expires_at: 1 },
    fetchImpl,
    env: {},
    onCredentialRefresh: async (credential) => {
      rotated = credential;
    },
  });
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].init.body), /grant_type=refresh_token/);
  assert.equal(calls[1].init.headers.authorization, "Bearer fresh");
  assert.equal(rotated.access_token, "fresh");
  assert.equal(rotated.refresh_token, "refresh");
  assert.ok(rotated.expires_at > Math.floor(Date.now() / 1000));
});
