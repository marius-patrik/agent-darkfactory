import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "out", "webview");
const engineDir = path.join(root, "src", "engine");
const studioCore = path.join(root, "node_modules", "@opendaw", "studio-core");

fs.mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const engineConfig = {
  entryPoints: [path.join(engineDir, "engine.ts")],
  outfile: path.join(outdir, "engine.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  loader: {
    ".ts": "ts",
  },
  alias: {
    crypto: path.join(engineDir, "node-polyfill.ts"),
    util: path.join(engineDir, "node-polyfill.ts"),
  },
};

/** @type {esbuild.BuildOptions} */
const peakWorkerConfig = {
  entryPoints: [path.join(engineDir, "workers", "peakWorker.ts")],
  outfile: path.join(outdir, "peakWorker.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: true,
};

async function copyAssets() {
  const files = [
    [path.join(engineDir, "index.html"), path.join(outdir, "engine.html")],
    [path.join(studioCore, "dist", "workers-main.js"), path.join(outdir, "workers-main.js")],
    [path.join(studioCore, "dist", "processors.js"), path.join(outdir, "processors.js")],
    [path.join(studioCore, "dist", "offline-engine.js"), path.join(outdir, "offline-engine.js")],
  ];

  for (const [src, dest] of files) {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing asset: ${src}`);
    }
    fs.copyFileSync(src, dest);
    console.log(`Copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
  }

  // Optional source maps for debugging.
  for (const name of ["workers-main.js.map", "processors.js.map", "offline-engine.js.map"]) {
    const src = path.join(studioCore, "dist", name);
    const dest = path.join(outdir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
    }
  }
}

async function build() {
  if (watch) {
    const ctxEngine = await esbuild.context(engineConfig);
    const ctxWorker = await esbuild.context(peakWorkerConfig);
    await Promise.all([ctxEngine.watch(), ctxWorker.watch()]);
    await copyAssets();
    console.log("Watching engine...");
  } else {
    await esbuild.build(engineConfig);
    await esbuild.build(peakWorkerConfig);
    await copyAssets();
    console.log("Engine build complete.");
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
