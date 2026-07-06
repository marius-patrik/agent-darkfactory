import { describe, expect, test } from "bun:test";
import path from "node:path";
import { sharedStateFromEnv } from "../src/state";

describe("shared state from environment", () => {
  test("respects explicit AGENTS_ROOT separate from AGENTS_HOME", () => {
    const state = sharedStateFromEnv("/ignored", {
      AGENTS_ROOT: "/opt/agents-os",
      AGENTS_HOME: "/agents/state",
    });

    expect(state.root).toBe(path.resolve("/opt/agents-os"));
    expect(state.stateDir).toBe(path.resolve("/agents/state"));
    expect(state.creditsFile).toBe(path.resolve("/agents/state/credits.json"));
  });

  test("falls back to AGENTS_HOME parent when AGENTS_ROOT is absent", () => {
    const state = sharedStateFromEnv("/repo", {
      AGENTS_HOME: "/repo/.agents",
    });

    expect(state.root).toBe(path.resolve("/repo"));
    expect(state.stateDir).toBe(path.resolve("/repo/.agents"));
  });
});
