import { describe, expect, test } from "bun:test";
import path from "node:path";
import { adapterEnv, adapterHome, adapters } from "../src/adapters";
import { sharedState } from "../src/state";

describe("CLI adapters", () => {
  test("codex, claude, kimi, and agy expose rooted homes", () => {
    const state = sharedState(path.join("repo"));

    expect(Object.keys(adapters).sort()).toEqual(["agy", "claude", "codex", "kimi"]);
    expect(adapterEnv(state, "codex").CODEX_HOME).toBe(path.join(state.clisDir, "codex"));
    expect(adapterEnv(state, "codex").AGENTS_ROOT).toBe(path.join("repo"));
    expect(adapterEnv(state, "codex").AGENTS_DATA).toBe(path.join("repo", "data"));
    expect(adapterEnv(state, "codex").AGENTS_WORKSPACE).toBe(path.join("repo", "os", "agents-workspace"));
    expect(adapterEnv(state, "codex").AGENTS_SECRETS).toBe(path.join(state.stateDir, "secrets"));
    expect(adapterEnv(state, "codex").AGENTS_DATA_REPOS).toBe(path.join(state.stateDir, "data-repos.json"));
    expect(adapterEnv(state, "codex").AGENTOS_DATA_ROOT).toBe(path.join("repo", "data", "data-agentos"));
    expect(adapterEnv(state, "claude").CLAUDE_CONFIG_DIR).toBe(path.join(state.clisDir, "claude"));
    expect(adapterEnv(state, "kimi").KIMI_CODE_HOME).toBe(path.join(state.clisDir, "kimi"));
    expect(adapterEnv(state, "agy").HOME).toBe(path.join(state.clisDir, "agy"));
  });

  test("credential mappings match managed CLI homes", () => {
    const state = sharedState(path.join("repo"));

    expect(path.join(adapterHome(state, "codex"), adapters.codex.credentials[0].target)).toBe(
      path.join(state.clisDir, "codex", "auth.json"),
    );
    expect(path.join(adapterHome(state, "claude"), adapters.claude.credentials[0].target)).toBe(
      path.join(state.clisDir, "claude", ".credentials.json"),
    );
    expect(path.join(adapterHome(state, "kimi"), adapters.kimi.credentials[0].target)).toBe(
      path.join(state.clisDir, "kimi", "credentials", "kimi-code.json"),
    );
    expect(path.join(adapterHome(state, "agy"), adapters.agy.credentials[0].target)).toBe(
      path.join(state.clisDir, "agy", ".gemini", "oauth_creds.json"),
    );
  });
});

