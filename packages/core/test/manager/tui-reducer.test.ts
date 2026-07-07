import { describe, expect, test } from "bun:test";
import {
  createStatusBarState,
  currentModel,
  currentProvider,
  statusBarLabel,
  statusBarReducer,
} from "../../src/manager/tui/reducer";

describe("status-bar state reducer", () => {
  const modelsByProvider = {
    kimi: ["kimi-k2", "moonshot-v1-8k"],
    claude: ["claude-sonnet-4-20250514", "claude-opus-4"],
    codex: ["codex-latest"],
  };
  const providers = ["kimi", "claude", "codex"];

  test("creates state with default provider and model", () => {
    const state = createStatusBarState({ providers, modelsByProvider });
    expect(currentProvider(state)).toBe("kimi");
    expect(currentModel(state)).toBe("kimi-k2");
    expect(state.mode).toBe("default");
    expect(state.tokensIn).toBe(0);
    expect(state.tokensOut).toBe(0);
  });

  test("cycles provider and resets model to first for the new provider", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "kimi", model: "moonshot-v1-8k" });
    state = statusBarReducer(state, { type: "cycle-provider" });
    expect(currentProvider(state)).toBe("claude");
    expect(currentModel(state)).toBe("claude-sonnet-4-20250514");
  });

  test("provider cycling wraps to start", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "codex" });
    state = statusBarReducer(state, { type: "cycle-provider" });
    expect(currentProvider(state)).toBe("kimi");
  });

  test("cycles model within active provider", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "kimi", model: "kimi-k2" });
    state = statusBarReducer(state, { type: "cycle-model" });
    expect(currentProvider(state)).toBe("kimi");
    expect(currentModel(state)).toBe("moonshot-v1-8k");
  });

  test("model cycling wraps to start", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "kimi", model: "moonshot-v1-8k" });
    state = statusBarReducer(state, { type: "cycle-model" });
    expect(currentModel(state)).toBe("kimi-k2");
  });

  test("set-provider ignores unknown providers", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "kimi" });
    state = statusBarReducer(state, { type: "set-provider", provider: "unknown" });
    expect(currentProvider(state)).toBe("kimi");
  });

  test("set-model ignores unknown models for active provider", () => {
    let state = createStatusBarState({ providers, modelsByProvider, provider: "kimi" });
    state = statusBarReducer(state, { type: "set-model", model: "codex-latest" });
    expect(currentModel(state)).toBe("kimi-k2");
  });

  test("updates token usage cumulatively", () => {
    let state = createStatusBarState({ providers, modelsByProvider });
    state = statusBarReducer(state, { type: "update-usage", usage: { tokensIn: 10, tokensOut: 5 } });
    expect(state.tokensIn).toBe(10);
    expect(state.tokensOut).toBe(5);
    expect(state.totalTokens).toBe(15);

    state = statusBarReducer(state, { type: "update-usage", usage: { tokensIn: 3, tokensOut: 2, totalTokens: 8 } });
    expect(state.tokensIn).toBe(13);
    expect(state.tokensOut).toBe(7);
    expect(state.totalTokens).toBe(23);
  });

  test("resets usage", () => {
    let state = createStatusBarState({ providers, modelsByProvider });
    state = statusBarReducer(state, { type: "update-usage", usage: { tokensIn: 10, tokensOut: 5 } });
    state = statusBarReducer(state, { type: "reset-usage" });
    expect(state.tokensIn).toBe(0);
    expect(state.tokensOut).toBe(0);
    expect(state.totalTokens).toBe(0);
  });

  test("sets status and message", () => {
    let state = createStatusBarState({ providers, modelsByProvider });
    state = statusBarReducer(state, { type: "set-status", status: "running" });
    expect(state.status).toBe("running");

    state = statusBarReducer(state, { type: "set-status", status: "error", message: "boom" });
    expect(state.status).toBe("error");
    expect(state.statusMessage).toBe("boom");
  });

  test("label includes provider, model, mode and tokens", () => {
    const state = createStatusBarState({ providers, modelsByProvider, provider: "claude", model: "claude-opus-4", mode: "chat" });
    expect(statusBarLabel(state)).toContain("claude/claude-opus-4");
    expect(statusBarLabel(state)).toContain("[chat]");
    expect(statusBarLabel(state)).toContain("in=0 out=0 total=0");
  });
});
