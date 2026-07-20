import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "out", "extension");

fs.mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(root, "src", "extension", "extension.ts")],
  outfile: path.join(outdir, "extension.js"),
  bundle: true,
  format: "cjs",
  target: "node18",
  platform: "node",
  external: ["vscode", "playwright-core", "chrome-launcher"],
  sourcemap: true,
};

/** @type {esbuild.BuildOptions} */
const serverConfig = {
  entryPoints: [path.join(root, "src", "extension", "server.ts")],
  outfile: path.join(outdir, "server.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "node",
  external: ["bun"],
  sourcemap: true,
};

async function build() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxServer = await esbuild.context(serverConfig);
    await Promise.all([ctxExt.watch(), ctxServer.watch()]);
    console.log("Watching extension...");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(serverConfig);
    fs.writeFileSync(
      path.join(outdir, "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2),
    );
    console.log("Extension build complete.");
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
