import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "out", "webview", "views");
const publicDir = path.join(root, "public", "views");
const sharedDir = path.join(root, "src", "views", "shared");

fs.mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes("--watch");

const views = ["timeline", "mixer", "pianoRoll", "browser", "graph"];

/** @type {esbuild.BuildOptions} */
const baseConfig = {
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: true,
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
    ".css": "css",
  },
  external: [],
};

function viewConfig(view) {
  return {
    ...baseConfig,
    entryPoints: [path.join(root, "src", "views", view, "main.tsx")],
    outfile: path.join(outdir, `${view}.js`),
  };
}

async function buildTailwind() {
  const tailwindInput = path.join(sharedDir, "global.css");
  const tailwindOutput = path.join(outdir, "styles.css");
  try {
    execSync(`npx tailwindcss -i "${tailwindInput}" -o "${tailwindOutput}" --minify`, {
      stdio: "inherit",
      cwd: root,
    });
    console.log("Tailwind CSS built.");
  } catch (error) {
    console.warn(
      "Tailwind CSS build skipped (tailwindcss not installed). Inline styles still provide theme support.",
    );
  }
}

async function copyHtml() {
  for (const view of views) {
    const src = path.join(publicDir, `${view}.html`);
    const dest = path.join(outdir, `${view}.html`);
    if (fs.existsSync(src)) {
      let html = fs.readFileSync(src, "utf8");
      // Ensure the generated Tailwind stylesheet is referenced if it exists.
      if (fs.existsSync(path.join(outdir, "styles.css"))) {
        html = html.replace("</head>", '  <link rel="stylesheet" href="./styles.css">\n</head>');
      }
      fs.writeFileSync(dest, html);
      console.log(`Copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
    }
  }
}

async function build() {
  if (watch) {
    const contexts = await Promise.all(views.map((view) => esbuild.context(viewConfig(view))));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    await buildTailwind();
    await copyHtml();
    console.log("Watching views...");
  } else {
    await Promise.all(views.map((view) => esbuild.build(viewConfig(view))));
    await buildTailwind();
    await copyHtml();
    console.log("Views build complete.");
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
