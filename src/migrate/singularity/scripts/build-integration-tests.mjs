import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "out", "tests", "integration");

fs.mkdirSync(outdir, { recursive: true });

const entries = fs
  .readdirSync(path.join(root, "tests", "integration"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => ({
    in: path.join(root, "tests", "integration", name),
    out: path.basename(name, ".ts"),
  }));

/** @type {esbuild.BuildOptions} */
const config = {
  entryPoints: entries,
  bundle: true,
  format: "cjs",
  target: "node18",
  platform: "node",
  external: ["vscode"],
  sourcemap: true,
  outdir,
  outExtension: { ".js": ".cjs" },
};

async function build() {
  await esbuild.build(config);
  console.log("Integration tests built.");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
