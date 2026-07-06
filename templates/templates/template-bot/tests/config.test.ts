import test from "node:test";
import assert from "node:assert/strict";

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
