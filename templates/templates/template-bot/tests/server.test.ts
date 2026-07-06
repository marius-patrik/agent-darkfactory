import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createWebhookServer, type WebhookReceiver } from "../src/server.js";

test("GET /healthz returns ok", async () => {
  await withServer(
    {
      async verifyAndReceive() {
        throw new Error("should not receive webhooks");
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz`);

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    }
  );
});

test("POST /webhook verifies and receives GitHub payloads", async () => {
  const received: unknown[] = [];

  await withServer(
    {
      async verifyAndReceive(options) {
        received.push(options);
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        body: JSON.stringify({ action: "ping" }),
        headers: {
          "x-github-delivery": "delivery-id",
          "x-github-event": "ping",
          "x-hub-signature-256": "sha256=signature"
        }
      });

      assert.equal(response.status, 202);
      assert.deepEqual(received, [
        {
          id: "delivery-id",
          name: "ping",
          signature: "sha256=signature",
          payload: "{\"action\":\"ping\"}"
        }
      ]);
    }
  );
});

test("POST /webhook rejects requests missing GitHub headers", async () => {
  await withServer(
    {
      async verifyAndReceive() {
        throw new Error("should not receive webhooks");
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        body: "{}"
      });

      assert.equal(response.status, 400);
      assert.equal(await response.text(), "Missing GitHub webhook headers");
    }
  );
});

test("unknown routes return 404", async () => {
  await withServer(
    {
      async verifyAndReceive() {
        throw new Error("should not receive webhooks");
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/missing`);

      assert.equal(response.status, 404);
    }
  );
});

async function withServer(
  receiver: WebhookReceiver,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createWebhookServer(receiver);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
