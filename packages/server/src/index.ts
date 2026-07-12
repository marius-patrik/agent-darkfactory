import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { KnowledgeBase } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

const app = express();

// Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
// read it back off the initialize response.
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json({ limit: "4mb" }));

app.use("/mcp", mcpRouter(kb));
app.use("/api", browseRouter(kb));
app.use("/api", chatRouter(kb));

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 3800);
app.listen(port, "0.0.0.0", () => {
  console.log(`understory serving bundle ${bundleRoot} on :${port} (web + /api + /mcp)`);
});
