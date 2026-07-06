import { createPageViewModel, renderHtml } from "./page";

export function createHtmlResponse(appName?: string): Response {
  return new Response(renderHtml(createPageViewModel(appName)), {
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return createHtmlResponse();
  }

  if (url.pathname === "/client.js") {
    return new Response(Bun.file(new URL("../dist/client.js", import.meta.url)), {
      headers: {
        "content-type": "text/javascript; charset=utf-8"
      }
    });
  }

  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: handleRequest
  });

  console.log(`Listening on http://localhost:${server.port}`);
}
