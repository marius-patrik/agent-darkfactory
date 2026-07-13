import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

test("loadConfig reads required GitHub App settings", () => {
  const config = loadConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "secret"
  });

  assert.equal(config.appId, "12345");
  assert.equal(config.privateKey, "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----");
  assert.equal(config.webhookSecret, "secret");
  assert.equal(config.port, 3000);
});

test("loadConfig accepts a valid PORT", () => {
  const config = loadConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "private-key",
    GITHUB_WEBHOOK_SECRET: "secret",
    PORT: "8080"
  });

  assert.equal(config.port, 8080);
});

test("loadConfig reads missing values from AGENTS_SECRETS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkfactory-secrets-"));
  try {
    await writeFile(path.join(root, "GITHUB_APP_ID.secret"), "12345\n");
    await writeFile(path.join(root, "GITHUB_PRIVATE_KEY.secret"), "private-key\n");
    await writeFile(path.join(root, "GITHUB_WEBHOOK_SECRET.secret"), "secret\n");

    const config = loadConfig({ AGENTS_SECRETS: root });

    assert.equal(config.appId, "12345");
    assert.equal(config.privateKey, "private-key");
    assert.equal(config.webhookSecret, "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects missing required settings", () => {
  assert.throws(
    () => loadConfig({ GITHUB_APP_ID: "12345", GITHUB_PRIVATE_KEY: "private-key" }),
    /GITHUB_WEBHOOK_SECRET/
  );
});

test("loadConfig rejects invalid PORT values", () => {
  assert.throws(
    () =>
      loadConfig({
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: "private-key",
        GITHUB_WEBHOOK_SECRET: "secret",
        PORT: "0"
      }),
    /PORT/
  );
});

test("loadConfig defaults controlRepo to marius-patrik/DarkFactory", () => {
  const config = loadConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "private-key",
    GITHUB_WEBHOOK_SECRET: "secret"
  });

  assert.equal(config.controlRepo.owner, "marius-patrik");
  assert.equal(config.controlRepo.repo, "DarkFactory");
});

test("loadConfig accepts a custom DARK_FACTORY_CONTROL_REPO", () => {
  const config = loadConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "private-key",
    GITHUB_WEBHOOK_SECRET: "secret",
    DARK_FACTORY_CONTROL_REPO: "owner/other-control"
  });

  assert.equal(config.controlRepo.owner, "owner");
  assert.equal(config.controlRepo.repo, "other-control");
});

test("loadConfig rejects malformed DARK_FACTORY_CONTROL_REPO", () => {
  assert.throws(
    () =>
      loadConfig({
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: "private-key",
        GITHUB_WEBHOOK_SECRET: "secret",
        DARK_FACTORY_CONTROL_REPO: "not-a-repo"
      }),
    /owner\/repo/
  );
});
