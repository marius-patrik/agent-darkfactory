import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseCredential,
  parseReview,
  persistRefreshedCredential,
  requestReview,
  reviewMaxTokens,
  reviewTimeoutMs,
  shouldTakeOver,
} from "./run-kimi-review.mjs";

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

test("recovers the final review object after unrelated balanced JSON", () => {
  const review = parseReview(`scratch {"phase":"analysis"}\nfinal ${JSON.stringify(validReview)}\ntrailing`);
  assert.equal(review.approved, true);
  assert.deepEqual(review.blocking_findings, []);
});

test("the last schema-valid object wins over a scratch verdict", () => {
  const scratch = JSON.stringify(validReview);
  const final = JSON.stringify({
    approved: false,
    summary: "Final review found a blocker.",
    blocking_findings: ["blocking final finding"],
    non_blocking_notes: [],
  });
  const review = parseReview(`scratch ${scratch}\nfinal ${final}`);
  assert.equal(review.approved, false);
  assert.deepEqual(review.blocking_findings, ["blocking final finding"]);
});

test("blocking findings always force a failed normalized verdict", () => {
  const review = parseReview(JSON.stringify({ ...validReview, approved: true, blocking_findings: ["unsafe"] }));
  assert.equal(review.approved, false);
  assert.deepEqual(review.blocking_findings, ["unsafe"]);
});

test("invalid review shapes report the missing contract without echoing model content", () => {
  assert.throws(
    () => parseReview('{"verdict":"approved","private":"do not echo"}'),
    (error) => {
      assert.match(error.message, /review\.approved must be boolean/);
      assert.doesNotMatch(error.message, /do not echo/);
      return true;
    },
  );
  assert.throws(
    () => parseReview('not-json-private-content'),
    (error) => {
      assert.match(error.message, /response was not parseable JSON/);
      assert.doesNotMatch(error.message, /private-content/);
      return true;
    },
  );
});

test("takeover dispatch uses only the trusted automation exit code", () => {
  assert.equal(shouldTakeOver(42), true);
  assert.equal(shouldTakeOver(0), false);
  assert.equal(shouldTakeOver(1), false);
  assert.equal(shouldTakeOver("42"), true);
});

test("takeover timeout is long enough for large reviews and remains bounded", () => {
  assert.equal(reviewTimeoutMs(), 900_000);
  assert.equal(reviewTimeoutMs("900000"), 900_000);
  assert.throws(() => reviewTimeoutMs("29999"), /between 30000 and 900000/);
  assert.throws(() => reviewTimeoutMs("invalid"), /between 30000 and 900000/);
});

test("large-review completion budget is configurable and bounded", () => {
  assert.equal(reviewMaxTokens(), 16_384);
  assert.equal(reviewMaxTokens("32768"), 32_768);
  assert.throws(() => reviewMaxTokens("4095"), /between 4096 and 32768/);
  assert.throws(() => reviewMaxTokens("invalid"), /between 4096 and 32768/);
});

test("workflow isolates Codex and Kimi credentials in separate provider steps", async () => {
  const workflow = await readFile(".github/workflows/codex-review.yml", "utf8");
  assert.match(workflow, /timeout-minutes: 35/);
  const codexStep = workflow.match(/- name: Run Codex review[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
  const kimiStep = workflow.match(/- name: Run credential-isolated Kimi takeover[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
  assert.match(codexStep, /CODEX_AUTH_JSON:/);
  assert.doesNotMatch(codexStep, /KIMI_AUTH_JSON:/);
  assert.match(kimiStep, /KIMI_AUTH_JSON:/);
  assert.doesNotMatch(kimiStep, /CODEX_AUTH_JSON:/);
  assert.match(kimiStep, /steps\.review\.outputs\.takeover == 'true'/);
});

test("review prompt budgets generated payloads as a file summary", async () => {
  const runner = await readFile(".github/scripts/run-codex-review.sh", "utf8");
  for (const path of [
    "packages/core/src/core/contracts-go/gen/**",
    "packages/core/src/core/clients/shared-ts/src/gen/**",
    "packages/core/src/gateway/agent_os/**",
    "packages/core/src/inference/python-agent/agent/gen/**",
  ]) {
    assert.match(runner, new RegExp(path.replaceAll("/", "\\/").replaceAll("*", "\\*")));
  }
  assert.match(runner, /git diff --find-renames --name-status/);
  assert.match(runner, /Generated payload file summary/);
  assert.match(runner, /trap cleanup_review_temp EXIT/);
  assert.match(runner, /rm -f .*GENERATED_FILE/);
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

test("missing Codex auth exports the immutable prompt before requesting takeover", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-review-takeover-"));
  const home = path.join(root, "codex-home");
  const context = path.join(root, "context");
  const output = path.join(root, "review.json");
  const prompt = path.join(root, "review-prompt.txt");
  await Promise.all([mkdir(home), mkdir(context)]);
  await writeFile(path.join(context, "AGENTS.md"), "rules\n");
  await writeFile(path.join(context, "linked-issues.md"), "issue\n");
  try {
    const result = spawnSync("bash", [".github/scripts/run-codex-review.sh"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        CODEX_HOME: home,
        REVIEW_CONTEXT_DIR: context,
        REVIEW_OUTPUT: output,
        PROMPT_EXPORT: prompt,
        BASE_BRANCH: "dev",
        BASE_REF: "HEAD",
      },
    });
    assert.equal(result.status, 42, result.stderr);
    assert.match(await readFile(prompt, "utf8"), /Managed repository agent context:\nrules/);
    assert.equal((await stat(prompt)).mode & 0o777, 0o644);
    assert.equal(JSON.parse(await readFile(output, "utf8")).approved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt mutation by the primary provider cannot cross the takeover boundary", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-review-prompt-mutation-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "codex-home");
  const context = path.join(root, "context");
  const output = path.join(root, "review.json");
  const prompt = path.join(root, "review-prompt.txt");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(context)]);
  await writeFile(path.join(home, "auth.json"), "{}\n");
  await writeFile(path.join(context, "AGENTS.md"), "rules\n");
  await writeFile(path.join(context, "linked-issues.md"), "issue\n");
  await writeFile(
    path.join(bin, "codex"),
    "#!/usr/bin/env bash\nprintf 'mutated\\n' > \"$PROMPT_EXPORT\"\nexit 1\n",
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
        PROMPT_EXPORT: prompt,
        BASE_BRANCH: "dev",
        BASE_REF: "HEAD",
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(await readFile(output, "utf8")).summary, /prompt changed/i);
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
  assert.match(request.init.body, /blocking_findings/);
  assert.match(request.init.body, /non_blocking_notes/);
  assert.equal(JSON.parse(request.init.body).temperature, 1);
  assert.equal(JSON.parse(request.init.body).max_tokens, 16_384);
  assert.match(JSON.parse(request.init.body).prompt_cache_key, /^[a-f0-9]{64}$/);
});

test("retries one transient provider failure with the same cached prompt", async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    bodies.push(init.body);
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }), {
      status: 200,
    });
  };
  const waits = [];
  const review = await requestReview({
    prompt: "large review",
    credential: { access_token: "token", expires_at: Math.floor(Date.now() / 1000) + 3600 },
    fetchImpl,
    env: {},
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(review.approved, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(bodies[0], bodies[1]);
});

test("does not retry a non-retryable provider response", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  };
  await assert.rejects(
    requestReview({
      prompt: "review",
      credential: { access_token: "token", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      fetchImpl,
      env: {},
      waitImpl: async () => assert.fail("non-retryable response must not wait"),
    }),
    /HTTP 400/,
  );
  assert.equal(calls, 1);
});

test("reports completion truncation distinctly from malformed JSON", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"approved":' } }] }),
      { status: 200 },
    );
  await assert.rejects(
    requestReview({
      prompt: "large review",
      credential: { access_token: "token", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      fetchImpl,
      env: {},
    }),
    /completion-token limit/,
  );
});

test("malformed response diagnostics expose only bounded metadata", async () => {
  const privateContent = "not-json-private-model-content";
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: privateContent } }] }),
      { status: 200 },
    );
  await assert.rejects(
    requestReview({
      prompt: "review",
      credential: { access_token: "token", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      fetchImpl,
      env: {},
    }),
    (error) => {
      assert.match(error.message, /finish_reason=stop/);
      assert.match(error.message, new RegExp(`content_chars=${privateContent.length}`));
      assert.doesNotMatch(error.message, /private-model-content/);
      return true;
    },
  );
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
