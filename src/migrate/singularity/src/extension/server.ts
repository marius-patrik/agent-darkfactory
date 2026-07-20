import path from "node:path";
import { file, serve } from "bun";

const ROOT = process.env.VSDAW_WEBVIEW_ROOT
  ? path.resolve(process.env.VSDAW_WEBVIEW_ROOT)
  : path.resolve(import.meta.dirname ?? ".", "..", "..", "out", "webview");

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".ts":
      return "application/typescript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const ip = server.requestIP(request);
    if (!ip || !isLoopback(ip.address)) {
      return new Response("Forbidden: loopback only", { status: 403 });
    }

    const url = new URL(request.url);
    let pathname = url.pathname;
    if (pathname === "/") pathname = "/engine.html";
    if (pathname === "/engine") pathname = "/engine.html";

    const safePath = path.normalize(path.join(ROOT, pathname));
    if (!safePath.startsWith(ROOT)) {
      return new Response("Forbidden: path outside root", { status: 403 });
    }

    const f = file(safePath);

    const headers = new Headers();
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Content-Type", contentTypeFor(safePath));

    return new Response(f, { headers });
  },
});

function shutdown(): void {
  try {
    server.stop();
  } catch {
    // ignore
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

console.log(`PORT:${server.port}`);
console.error(`VSDAW audio server listening on http://127.0.0.1:${server.port}`);
