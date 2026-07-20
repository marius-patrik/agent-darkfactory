export const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(new URL("./index.html", import.meta.url)));
    }

    if (url.pathname === "/client.ts") {
      return new Response(Bun.file(new URL("./client.ts", import.meta.url)));
    }

    return new Response("Not found", { status: 404 });
  }
});

console.log(`Listening on http://localhost:${server.port}`);
