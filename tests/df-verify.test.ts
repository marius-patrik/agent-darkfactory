import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const { readVerificationTarget, verifyWorkerRun }: any = await import("../.github/scripts/df-verify.mjs?unit=df-verify-test");

function base64Json(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function workerLedger(provider: string, model: string) {
  const modelTier = provider === "codex" ? "high" : "medium";
  const effort = "medium";
  return {
    issue: "marius-patrik/example#42",
    branch: "df/42-slug",
    base_branch: "dev",
    status: "success",
    pull_request_number: 99,
    model_request: { schemaVersion: 1, modelTier, effort },
    agent_os: {
      receipt: {
        schemaVersion: 1,
        requested: { modelTier, effort },
        resolved: { provider, model, agentPreset: provider === "codex" ? "Sol" : "Kimi", providerVersion: "1.2.3" },
        attempts: [{ number: 1, outcome: "success", reason: null }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        outcome: "success",
        blockReason: null
      }
    }
  };
}

test("readVerificationTarget accepts a valid workflow artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-verify-target-"));
  try {
    const targetPath = join(root, "target.json");
    await writeFile(targetPath, JSON.stringify({ repo: "marius-patrik/example", issue_number: 42 }));

    const target = await readVerificationTarget(targetPath);
    assert.deepEqual(target, {
      targetRepo: { owner: "marius-patrik", repo: "example" },
      issueNumber: 42
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVerificationTarget rejects malformed or incomplete artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-verify-target-"));
  try {
    const malformedPath = join(root, "target.json");
    await writeFile(malformedPath, JSON.stringify({ repo: "not-a-repository", issue_number: 0 }));

    await assert.rejects(readVerificationTarget(malformedPath), /Invalid repository name|Invalid DarkFactory verification target issue/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyWorkerRun marks issue df:done when claim matches GitHub reality", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const gh = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/example") {
        return [{ name: "2026-07-07T00-00-00Z-df-work.json", type: "file" }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/example/2026-07-07T00-00-00Z-df-work.json") {
        return {
          type: "file",
          encoding: "base64",
          content: base64Json(workerLedger("codex", "gpt-5.5"))
        };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/42") {
        return { number: 42, state: "open", labels: [{ name: "df:running" }] };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls/99") {
        return {
          number: 99,
          state: "open",
          html_url: "https://github.com/marius-patrik/example/pull/99",
          head: { ref: "df/42-slug", repo: { owner: { login: "marius-patrik" }, name: "example", full_name: "marius-patrik/example" } },
          base: { ref: "dev" },
          user: { login: "mp-agents[bot]" },
          body: "<!-- dark-factory:worker-pr issue=42 -->\n\nCloses #42"
        };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls/99/files?per_page=100&page=1") {
        return [{ filename: "src/file.ts" }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/df%2F42-slug") {
        return { ref: "refs/heads/df/42-slug" };
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/42/comments?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/comments") return {};
      return {};
    }
  };

  const result = await verifyWorkerRun(gh, {
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    targetRepo: { owner: "marius-patrik", repo: "example" },
    issueNumber: 42,
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "workflow_run",
    dryRun: false,
    log: () => {},
    warn: () => {}
  });

  assert.equal(result.verified, true);
  const labelCall = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/42/labels");
  assert.deepEqual(labelCall?.body, { labels: ["df:done"] });
});

test("verifyWorkerRun blocks issue and files blocker issue when PR is on wrong base", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const gh = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/example") {
        return [{ name: "2026-07-07T00-00-00Z-df-work.json", type: "file" }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/example/2026-07-07T00-00-00Z-df-work.json") {
        return {
          type: "file",
          encoding: "base64",
          content: base64Json(workerLedger("kimi", "kimi-k2"))
        };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/42") {
        return { number: 42, state: "open", labels: [{ name: "df:running" }] };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls/99") {
        return {
          number: 99,
          state: "open",
          html_url: "https://github.com/marius-patrik/example/pull/99",
          head: { ref: "df/42-slug", repo: { owner: { login: "marius-patrik" }, name: "example", full_name: "marius-patrik/example" } },
          base: { ref: "main" },
          user: { login: "mp-agents[bot]" },
          body: "<!-- dark-factory:worker-pr issue=42 -->\n\nCloses #42"
        };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls/99/files?per_page=100&page=1") {
        return [{ filename: "src/file.ts" }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/df%2F42-slug") {
        return { ref: "refs/heads/df/42-slug" };
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/42/comments?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/comments") return {};
      if (method === "GET" && path === "/repos/marius-patrik/DarkFactory/issues?state=open&per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/issues") return { number: 7 };
      return {};
    }
  };

  const result = await verifyWorkerRun(gh, {
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    targetRepo: { owner: "marius-patrik", repo: "example" },
    issueNumber: 42,
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "workflow_run",
    dryRun: false,
    log: () => {},
    warn: () => {}
  });

  assert.equal(result.verified, false);
  assert.ok(result.mismatches.some((m: string) => m.includes("base branch")));
  const labelCall = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/42/labels");
  assert.deepEqual(labelCall?.body, { labels: ["df:blocked"] });
  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/issues"));
});
