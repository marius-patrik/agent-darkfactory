import { describe, expect, test } from "bun:test";

import { createPageViewModel, escapeHtml, renderHtml } from "../src/page";
import { createHtmlResponse, handleRequest } from "../src/server";

describe("createPageViewModel", () => {
  test("creates default page content", () => {
    expect(createPageViewModel()).toEqual({
      title: "template-web",
      message: "template-web is running."
    });
  });

  test("uses a supplied app name", () => {
    expect(createPageViewModel("DarkFactory")).toEqual({
      title: "DarkFactory",
      message: "DarkFactory is running."
    });
  });
});

describe("renderHtml", () => {
  test("renders escaped page content", () => {
    const html = renderHtml({
      title: "<App>",
      message: "A & B"
    });

    expect(html).toContain("&lt;App&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain('src="/client.js"');
  });
});

describe("server helpers", () => {
  test("creates html responses", () => {
    const response = createHtmlResponse("Template");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("handles the homepage", async () => {
    const response = await handleRequest(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("template-web is running.");
  });

  test("returns not found for unknown routes", async () => {
    const response = await handleRequest(new Request("http://localhost/missing"));

    expect(response.status).toBe(404);
  });
});

describe("escapeHtml", () => {
  test("escapes html-sensitive characters", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
