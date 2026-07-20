import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "out", "extension", "server.js");
const webviewRoot = path.join(root, "out", "webview");

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [serverPath], {
      env: { ...process.env, VSDAW_WEBVIEW_ROOT: webviewRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server did not announce port within 10 seconds"));
    }, 10000);

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      const match = text.match(/PORT:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: Number.parseInt(match[1], 10) });
      }
    });

    proc.stderr.on("data", (data) => {
      console.error("[server]", data.toString().trim());
    });

    proc.on("error", reject);
  });
}

async function main() {
  const { proc, port } = await startServer();
  const url = `http://localhost:${port}/engine?projectId=phase0-test`;

  let crossOriginIsolated = null;
  const logs = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("console", (msg) => {
      const text = msg.text();
      logs.push({ type: msg.type(), text });
      console.log(`[console.${msg.type()}]`, text);
    });

    page.on("pageerror", (err) => {
      errors.push(err.message);
      console.error("[pageerror]", err.message);
    });

    page.on("requestfailed", (req) => {
      const failure = req.failure();
      errors.push(`Request failed: ${req.url()} - ${failure?.errorText ?? "unknown"}`);
      console.error("[requestfailed]", req.url(), failure?.errorText);
    });

    await page.goto(url, { waitUntil: "networkidle" });

    // Give the engine a moment to boot and postMessage.
    await page.waitForTimeout(2000);

    crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated);
    console.log("\n=== Results ===");
    console.log("crossOriginIsolated:", crossOriginIsolated);
    console.log("Console logs:", logs.length);
    console.log("Errors:", errors.length);

    if (crossOriginIsolated !== true) {
      throw new Error(`crossOriginIsolated is ${crossOriginIsolated}, expected true`);
    }
    if (errors.length > 0) {
      throw new Error(`Encountered ${errors.length} page errors`);
    }

    console.log("Phase 0 engine isolation check PASSED.");
  } finally {
    await browser.close();
    proc.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
