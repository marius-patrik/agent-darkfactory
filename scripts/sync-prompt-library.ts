import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { syncPromptLibrary } from "../src/prompt-sync.js";

export { syncPromptLibrary } from "../src/prompt-sync.js";

export async function runPromptLibrarySyncCli(): Promise<void> {
  const result = await syncPromptLibrary();
  console.log(
    `Synced ${result.artifactCount} artifact checksums and ${result.fixtureCount} snapshots in ${result.root}`
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await runPromptLibrarySyncCli();
}
