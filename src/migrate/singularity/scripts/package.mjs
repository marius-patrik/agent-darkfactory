import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkgDir = path.join(root, "out", "package");
const outDir = path.join(root, "out");

function copy(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function rm(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

rm(pkgDir);
fs.mkdirSync(pkgDir, { recursive: true });

// Copy extension metadata and runtime assets.
const files = [
  "package.json",
  "README.md",
  "readme.md",
  "CHANGELOG.md",
  "changelog.md",
  "LICENSE",
  "LICENSE.txt",
  "ThirdPartyNotices.txt",
  "ThirdPartyNotices.txt",
  "media",
  "out/extension",
  "out/webview",
];

for (const file of files) {
  copy(path.join(root, file), path.join(pkgDir, file));
}

// Write a .vscodeignore that keeps node_modules but drops source/tests and
// type-only packages pulled in by npm production installs.
const vscodeignoreContent = `# Build tooling and source maps
*.map
out/**/*.map

# Source code and tests
src/**
tests/**
scripts/**
specs/**
plans/**

# Development/configuration files
.github/**
.vscode/**
.vscode-test.mjs
.husky/**
.env*
*.log
*.vsix

# Build/test artifacts
out/tests/**
out/fixtures/**
out/workspace/**
public/**
coverage/**

# Tooling configs
biome.json
jest.config.cjs
postcss.config.js
tailwind.config.js
tsconfig.json
tsconfig.test.json
bun.lock
package-lock.json
yarn.lock
pnpm-lock.yaml

# Documentation (keep README and CHANGELOG at root for marketplace)
docs/**

# Type-only packages that npm production installs due to package metadata
node_modules/@types/**
node_modules/undici-types/**
`;
fs.writeFileSync(path.join(pkgDir, ".vscodeignore"), vscodeignoreContent);

// Install only production dependencies into the staging directory.
console.log("Installing production dependencies in staging directory...");
execSync("npm install --omit=dev --no-audit --no-fund", {
  cwd: pkgDir,
  stdio: "inherit",
});

// Package from the staging directory. We omit --no-dependencies so that the
// production node_modules installed above are included in the VSIX.
console.log("Packaging VSIX...");
execSync("npx @vscode/vsce package", {
  cwd: pkgDir,
  stdio: "inherit",
});

const vsixName = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")).name;
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")).version;
const built = path.join(pkgDir, `${vsixName}-${version}.vsix`);
const final = path.join(root, `${vsixName}-${version}.vsix`);
fs.copyFileSync(built, final);
console.log(`Created ${final}`);
