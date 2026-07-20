import { expect, test, afterAll } from "bun:test";

// Parallel repository gates may already own the development port. Tests bind
// an ephemeral port so verification never depends on unrelated host state.
process.env.PORT = "0";
const { server } = await import("./server");

const baseUrl = `http://localhost:${server.port}`;

test("serves index.html at /", async () => {
  const response = await fetch(`${baseUrl}/`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Agent OS web template");
});

test("serves index.html at /index.html", async () => {
  const response = await fetch(`${baseUrl}/index.html`);
  expect(response.status).toBe(200);
});

test("serves client.ts source", async () => {
  const response = await fetch(`${baseUrl}/client.ts`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Agent OS web template is running");
});

test("returns 404 for unknown paths", async () => {
  const response = await fetch(`${baseUrl}/missing`);
  expect(response.status).toBe(404);
});

afterAll(() => {
  server.stop();
});
