import path from "node:path";
import { valid } from "semver";

const productManifestPath = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "package.json",
);

export async function readAuthoritativeProductVersion(): Promise<string> {
  const manifest = (await Bun.file(productManifestPath).json()) as {
    version?: unknown;
  };
  if (
    typeof manifest.version !== "string" ||
    manifest.version !== manifest.version.trim() ||
    !/^[0-9]/.test(manifest.version) ||
    valid(manifest.version, { loose: false }) === null
  ) {
    throw new Error(
      `authoritative product manifest has no valid semantic version: ${productManifestPath}`,
    );
  }
  return manifest.version;
}
