import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureSharedState,
  readSessionConfig,
  sharedState,
  sharedStateFromEnv,
  writeSessionConfig,
} from "../src/state";
import {
  canonicalChildEnvironment,
  overlayChildEnvironment,
  resolvePersonalAgentsHome,
  resolveRuntimeAgentsHome,
  resolveUserHome,
} from "../src/runtime-paths";

describe("shared state from environment", () => {
  test("respects explicit AGENTS_ROOT separate from AGENTS_HOME", () => {
    const state = sharedStateFromEnv("/ignored", {
      AGENTS_ROOT: "/opt/agents-os",
      AGENTS_HOME: "/agents/state",
      AGENTS_USER_HOME: "/Users/patrik",
      AGENTS_DATA: "/second/data/root",
      AGENTS_WORKSPACE: "/second/workspace/root",
    });

    expect(state.root).toBe(path.resolve("/opt/agents-os"));
    expect(state.userHome).toBe(path.resolve("/Users/patrik"));
    expect(state.stateDir).toBe(path.resolve("/agents/state"));
    expect(state.creditsFile).toBe(path.resolve("/agents/state/credits.json"));
    expect(state.workspaceDir).toBe(path.resolve("/agents/state/runtime/workspaces"));
  });

  test("uses the invocation root when AGENTS_ROOT is absent", () => {
    const state = sharedStateFromEnv("/repo", {
      AGENTS_HOME: "/repo/.agents",
    });

    expect(state.root).toBe(path.resolve("/repo"));
    expect(state.stateDir).toBe(path.resolve("/repo/.agents"));
  });

  test("does not collide with project guidance when state env is absent", () => {
    const env = { AGENTS_USER_HOME: "/Users/patrik" };
    const first = sharedStateFromEnv("/repo-one", env);
    const second = sharedStateFromEnv("/repo-two", env);

    expect(first.stateDir).toBe(path.resolve("/Users/patrik/.agents"));
    expect(second.stateDir).toBe(first.stateDir);
    expect(first.root).toBe(path.resolve("/repo-one"));
    expect(second.root).toBe(path.resolve("/repo-two"));
  });

  test("rejects the retired model sentinel in canonical defaults and provider lists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-config-model-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await expect(
        writeSessionConfig(state, { schemaVersion: 1, defaultProvider: "codex", defaultModel: "default" }),
      ).rejects.toThrow("retired default model sentinel");
      await expect(
        writeSessionConfig(state, { schemaVersion: 1, providerModels: { codex: ["default"] } }),
      ).rejects.toThrow("contains an invalid or duplicate model");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates canonical provider route status and policy-version state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-config-route-policy-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await writeSessionConfig(state, {
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerRouteStatus: { kimi: "decommissioned", codex: "enabled" },
      });
      expect(await readSessionConfig(state)).toEqual({
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerRouteStatus: { kimi: "decommissioned", codex: "enabled" },
      });
      await expect(
        writeSessionConfig(state, {
          schemaVersion: 1,
          providerRouteStatus: { unknown: "enabled" } as never,
        }),
      ).rejects.toThrow("unknown provider");
      await expect(
        writeSessionConfig(state, {
          schemaVersion: 1,
          providerRouteStatus: { kimi: "healthy" } as never,
        }),
      ).rejects.toThrow("providerRouteStatus.kimi is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runtime path resolution", () => {
  test("removes retired state variables from every child environment", () => {
    expect(
      canonicalChildEnvironment({
        AGENTS_HOME: "/canonical",
        ROMMIE_HOME: "/retired",
        ROMMIE_NODE_ID: "retired-node",
        AGENTOS_DATA_ROOT: "/retired-data",
        AGENTS_DATA: "/duplicate-data-parent",
        AGENTS_WORKSPACE: "/stale-workspace",
        AGENTS_SYSTEM_DATA_ROOT: "/stale-system-data",
        PATH: "/bin",
      }),
    ).toEqual({ AGENTS_HOME: "/canonical", PATH: "/bin" });
  });

  test("authoritative child overlays remove mixed-case aliases", () => {
    expect(
      overlayChildEnvironment(
        { HOME: "/ambient", userprofile: "/ambient-profile", kimi_code_home: "/ambient-kimi", PATH: "/bin" },
        { HOME: "/managed", USERPROFILE: "/managed", KIMI_CODE_HOME: "/managed/kimi" },
      ),
    ).toEqual({ HOME: "/managed", USERPROFILE: "/managed", KIMI_CODE_HOME: "/managed/kimi", PATH: "/bin" });
  });

  test("explicit user home wins over a provider-rooted HOME", () => {
    expect(
      resolveUserHome(
        {
          HOME: "/Users/patrik/.agents/clis/codex",
          AGENTS_USER_HOME: "/Users/patrik",
        },
        "/Users/patrik/.agents/clis/codex",
      ),
    ).toBe(path.resolve("/Users/patrik"));
  });

  test("recovers the real home from the canonical provider path", () => {
    expect(resolveUserHome({}, "/Users/patrik/.agents/clis/codex")).toBe(path.resolve("/Users/patrik"));
  });

  test("personal and runtime state honor explicit roots", () => {
    const env = {
      HOME: "/Users/patrik/.agents/clis/codex",
      AGENTS_HOME: "/Users/patrik/.agents",
    };
    expect(resolvePersonalAgentsHome(env, env.HOME)).toBe(path.resolve("/Users/patrik/.agents"));
    expect(resolveRuntimeAgentsHome("/repo", env)).toBe(path.resolve("/Users/patrik/.agents"));
  });

  test("runtime state is independent of cwd when no explicit state root exists", () => {
    const env = { AGENTS_USER_HOME: "/Users/patrik" };
    expect(resolveRuntimeAgentsHome("/repo-one", env)).toBe(path.resolve("/Users/patrik/.agents"));
    expect(resolveRuntimeAgentsHome("/repo-two", env)).toBe(path.resolve("/Users/patrik/.agents"));
  });
});
