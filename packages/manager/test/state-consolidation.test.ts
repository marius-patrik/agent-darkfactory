import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyProviderRootLocation,
  formatToolStatus,
  readToolStatus,
  toolCanonicalPath,
  toolForbiddenPath,
} from "../src/state-consolidation";

describe("single-root provider state", () => {
  test("reports missing when neither canonical nor forbidden state exists", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      const status = await readToolStatus("codex", homeDir, agentsHome);
      expect(status.location).toBe("missing");
      expect(status.forbidden).toBe(path.join(homeDir, ".codex"));
      expect(status.canonical).toBe(path.join(agentsHome, "clis", "codex"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("accepts only the canonical provider home", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      await Bun.write(path.join(toolCanonicalPath("kimi", agentsHome), "config.json"), "{}");
      const status = await readToolStatus("kimi", homeDir, agentsHome);
      expect(status.location).toBe("canonical");
      expect(status.forbiddenLinkTarget).toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("classifies a standalone provider home as forbidden", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      await Bun.write(path.join(toolForbiddenPath("claude", homeDir), "config.json"), "{}");
      const status = await readToolStatus("claude", homeDir, path.join(homeDir, ".agents"));
      expect(status.location).toBe("forbidden");
      expect(formatToolStatus([status])).toContain("forbidden");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("classifies both duplicate roots and bridge links as split", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      const canonical = toolCanonicalPath("codex", agentsHome);
      const forbidden = toolForbiddenPath("codex", homeDir);
      await Bun.write(path.join(canonical, "config.toml"), "");
      await symlink(canonical, forbidden);

      const linked = await readToolStatus("codex", homeDir, agentsHome);
      expect(linked.location).toBe("split");
      expect(linked.forbiddenLinkTarget).toBe(canonical);

      await unlink(forbidden);
      await Bun.write(path.join(forbidden, "config.toml"), "");
      expect((await readToolStatus("codex", homeDir, agentsHome, "linux")).location).toBe("split");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("accepts declared physical desktop roots as app-owned without making them authority", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      await Bun.write(path.join(toolCanonicalPath("codex", agentsHome), "bin", "codex.exe"), "binary");
      await Bun.write(path.join(toolForbiddenPath("codex", homeDir), "state.db"), "app cache");

      const status = await readToolStatus("codex", homeDir, agentsHome, "win32");
      expect(status.location).toBe("app-owned");
      expect(status.forbiddenLinkTarget).toBeNull();
      expect(formatToolStatus([status])).toContain("app-owned");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("never treats a bridge or standalone-only root as app-owned", () => {
    expect(
      classifyProviderRootLocation({
        canonicalExists: true,
        standaloneExists: true,
        standaloneLinkTarget: "C:/canonical",
        appOwnedAllowed: true,
      }),
    ).toBe("split");
    expect(
      classifyProviderRootLocation({
        canonicalExists: false,
        standaloneExists: true,
        standaloneLinkTarget: null,
        appOwnedAllowed: true,
      }),
    ).toBe("forbidden");
  });

  test("Agent OS itself has exactly one canonical root", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      expect((await readToolStatus("agents", homeDir, agentsHome)).location).toBe("missing");
      await Bun.write(path.join(agentsHome, "manifest.json"), "{}");
      const status = await readToolStatus("agents", homeDir, agentsHome);
      expect(status.location).toBe("canonical");
      expect(status.forbidden).toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
