import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface WebhookReceiver {
  verifyAndReceive(options: {
    id: string;
    name: string;
    signature: string;
    payload: string;
  }): Promise<void>;
}

export function createWebhookServer(receiver: WebhookReceiver) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      send(response, 200, "ok");
      return;
    }

    if (request.method !== "POST" || request.url !== "/webhook") {
      send(response, 404, "Not found");
      return;
    }

    await handleWebhookRequest(request, response, receiver);
  });
}

async function handleWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  receiver: WebhookReceiver
): Promise<void> {
  const id = request.headers["x-github-delivery"];
  const name = request.headers["x-github-event"];
  const signature = request.headers["x-hub-signature-256"];

  if (typeof id !== "string" || typeof name !== "string" || typeof signature !== "string") {
    send(response, 400, "Missing GitHub webhook headers");
    return;
  }

  const payload = await readRequestBody(request);

  try {
    await receiver.verifyAndReceive({ id, name, signature, payload });
    send(response, 202, "Accepted");
  } catch (error) {
    console.error(error);
    send(response, 400, "Webhook rejected");
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}
