// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  availableProviders,
  isProviderFailure,
  loadProviderRegistry,
  prepareProviderAuth,
  resolveModel,
  runProviderWorker,
  runWithFailover
} from "../.github/scripts/df-providers.mjs";

const sampleRegistry = {
  schemaVersion: 1,
  providers: [
    {
      id: "kimi",
      enabled: true,
      secret: "KIMI_AUTH_JSON",
      install: { method: "npm", package: "@moonshot-ai/kimi-code", version: "latest" },
      models: {
        default: "kimi-k2",
        byTaskClass: { mechanical: "kimi-k2", standard: "kimi-k2", hard: "kimi-k2" }
      },
      maxConcurrency: 2
    },
    {
      id: "codex",
      enabled: true,
      secret: "CODEX_AUTH_JSON",
      models: {
        default: "gpt-5.5",
        byTaskClass: { mechanical: "gpt-5.5", standard: "gpt-5.5", hard: "gpt-5.5" }
      },
      maxConcurrency: 1,
      dockerImage: "darkfactory-codex-worker"
    },
    {
      id: "agy",
      enabled: false,
      secret: "AGY_AUTH_JSON",
      models: { default: "agy-default" },
      maxConcurrency: 1
    }
  ]
};

test("loadProviderRegistry reads schemaVersion and providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-providers-"));
  try {
    await mkdir(join(root, ".darkfactory"), { recursive: true });
    await writeFile(join(root, ".darkfactory", "providers.json"), JSON.stringify(sampleRegistry));
    const registry = await loadProviderRegistry(root);
    assert.equal(registry.schemaVersion, 1);
    assert.equal(registry.providers.length, 3);
    assert.equal(registry.providers[0].id, "kimi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProviderRegistry returns empty registry when file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-providers-"));
  try {
    const registry = await loadProviderRegistry(root);
    assert.equal(registry.schemaVersion, 1);
    assert.deepEqual(registry.providers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("availableProviders preserves order and skips disabled or missing-secret providers", () => {
  const env = {
    KIMI_AUTH_JSON: "kimi-secret",
    CODEX_AUTH_JSON: "",
    AGY_AUTH_JSON: "agy-secret"
  };
  const providers = availableProviders(sampleRegistry, env);
  assert.deepEqual(providers.map((p) => p.id), ["kimi"]);
});

test("resolveModel falls back to default and supports task class overrides", () => {
  const provider = {
    models: {
      default: "default-model",
      byTaskClass: { mechanical: "mechanical-model", hard: "hard-model" }
    }
  };
  assert.equal(resolveModel(provider, "mechanical"), "mechanical-model");
  assert.equal(resolveModel(provider, "hard"), "hard-model");
  assert.equal(resolveModel(provider, "standard"), "default-model");
  assert.equal(resolveModel(provider), "default-model");
});

test("isProviderFailure classifies codex quota/rate-limit signatures", () => {
  assert.equal(isProviderFailure("codex", { errorMessage: "You've hit your usage limit" }), true);
  assert.equal(isProviderFailure("codex", { stderr: "usage_limit exceeded" }), true);
  assert.equal(isProviderFailure("codex", { stdout: "rate limit hit", exitCode: 429 }), true);
  assert.equal(isProviderFailure("codex", { errorMessage: "syntax error in worker output" }), false);
});

test("isProviderFailure classifies kimi auth/quota signatures", () => {
  assert.equal(isProviderFailure("kimi", { errorMessage: "403 billing-cycle quota exceeded" }), true);
  assert.equal(isProviderFailure("kimi", { stderr: "401 unauthorized" }), true);
  assert.equal(isProviderFailure("kimi", { errorMessage: "invalid api key" }), true);
  assert.equal(isProviderFailure("kimi", { errorMessage: "worker could not parse acceptance criteria" }), false);
});

test("isProviderFailure classifies agy authentication/quota signatures", () => {
  assert.equal(isProviderFailure("agy", { errorMessage: "authentication failed" }), true);
  assert.equal(isProviderFailure("agy", { stderr: "usage limit reached" }), true);
  assert.equal(isProviderFailure("agy", { errorMessage: "test assertion failed" }), false);
});

test("runWithFailover succeeds on first provider", async () => {
  const providers = [{ id: "kimi", enabled: true, secret: "KIMI_AUTH_JSON" }];
  const result = await runWithFailover(providers, async (provider, model) => "ok", { taskClass: "standard" });
  assert.equal(result.provider, "kimi");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].result, "success");
});

test("runWithFailover retries on provider failure and records attempts", async () => {
  const providers = [
    { id: "kimi", enabled: true, secret: "KIMI_AUTH_JSON" },
    { id: "codex", enabled: true, secret: "CODEX_AUTH_JSON" }
  ];
  let calls = 0;
  const result = await runWithFailover(
    providers,
    async (provider) => {
      calls += 1;
      if (provider.id === "kimi") {
        const error = new Error("403 billing quota") as any;
        error.stdout = "";
        error.stderr = "quota";
        throw error;
      }
      return "ok";
    },
    { taskClass: "standard" }
  );
  assert.equal(calls, 2);
  assert.equal(result.provider, "codex");
  assert.equal(result.attempts[0].result, "provider-failure");
  assert.equal(result.attempts[1].result, "success");
});

test("runWithFailover throws providerExhausted when all providers fail", async () => {
  const providers = [
    { id: "kimi", enabled: true, secret: "KIMI_AUTH_JSON" },
    { id: "codex", enabled: true, secret: "CODEX_AUTH_JSON" }
  ];
  await assert.rejects(
    () =>
      runWithFailover(
        providers,
        async () => {
          const error = new Error("You've hit your usage limit") as any;
          error.stdout = "";
          error.stderr = "";
          throw error;
        },
        { taskClass: "standard" }
      ),
    (error: any) => {
      assert.equal(error.providerExhausted, true);
      assert.match(error.message, /all providers quota-limited/);
      assert.equal(error.attempts.length, 2);
      return true;
    }
  );
});

test("runWithFailover does not retry on task failure", async () => {
  const providers = [
    { id: "kimi", enabled: true, secret: "KIMI_AUTH_JSON" },
    { id: "codex", enabled: true, secret: "CODEX_AUTH_JSON" }
  ];
  let calls = 0;
  await assert.rejects(
    () =>
      runWithFailover(
        providers,
        async () => {
          calls += 1;
          throw new Error("real blocker: test failed");
        },
        { taskClass: "standard" }
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /real blocker/);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("prepareProviderAuth writes codex auth without echoing secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-auth-"));
  try {
    const provider = { id: "codex", enabled: true, secret: "CODEX_AUTH_JSON" };
    await prepareProviderAuth(provider, '{"token":"secret"}', root);
    const content = await readFile(join(root, "auth.json"), "utf8");
    assert.equal(content, '{"token":"secret"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareProviderAuth writes kimi credentials to expected path", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-auth-"));
  try {
    const provider = { id: "kimi", enabled: true, secret: "KIMI_AUTH_JSON" };
    await prepareProviderAuth(provider, '{"credential":"secret"}', root);
    const content = await readFile(join(root, ".kimi-code", "credentials", "kimi-code.json"), "utf8");
    assert.equal(content, '{"credential":"secret"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runProviderWorker rejects disabled agy provider", async () => {
  const provider = { id: "agy", enabled: false, secret: "AGY_AUTH_JSON" };
  await assert.rejects(
    async () => runProviderWorker(provider, { worktree: "/tmp", homeDir: "/tmp", model: "agy-default", codeEffort: "low", controlRoot: "/tmp" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /disabled/);
      return true;
    }
  );
});
