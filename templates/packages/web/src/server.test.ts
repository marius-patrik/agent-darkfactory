import { expect, test, afterAll } from "bun:test";
import { server } from "./server";

const baseUrl = `http://localhost:${server.port}`;

test("serves index.html at /", async () => {
  const response = await fetch(`${baseUrl}/`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("template-web");
});

test("serves index.html at /index.html", async () => {
  const response = await fetch(`${baseUrl}/index.html`);
  expect(response.status).toBe(200);
});

test("serves client.ts source", async () => {
  const response = await fetch(`${baseUrl}/client.ts`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("template-web is running");
});

test("returns 404 for unknown paths", async () => {
  const response = await fetch(`${baseUrl}/missing`);
  expect(response.status).toBe(404);
});

afterAll(() => {
  server.stop();
});
