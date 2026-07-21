import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sharedStateAt } from "../src/state";
import {
  inspectProviderExecutable,
  readProviderRegistry,
  verifyProviderRegistration,
  writeProviderRegistration,
} from "../src/provider-registry";

describe("provider executable registry", () => {
  test("pins an absolute executable by resolved path, version, and checksum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-registry-"));
    try {
      const state = sharedStateAt(root, path.join(root, ".andromeda"), path.join(root, "user"));
      const executable = path.join(root, "bin", "codex");
      await Bun.write(executable, "#!/bin/sh\nexit 0\n");
      const registration = await inspectProviderExecutable("codex", executable, "codex-cli 1.2.3", "2026-07-10T00:00:00.000Z");
      await writeProviderRegistration(state, registration);

      const stored = (await readProviderRegistry(state)).providers.codex!;
      expect(stored.executable).toBe(executable);
      expect(stored.version).toBe("codex-cli 1.2.3");
      expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await verifyProviderRegistration(stored)).ok).toBe(true);

      await Bun.write(executable, "#!/bin/sh\nexit 1\n");
      const changed = await verifyProviderRegistration(stored);
      expect(changed.ok).toBe(false);
      expect(changed.issues.join("\n")).toContain("checksum changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

