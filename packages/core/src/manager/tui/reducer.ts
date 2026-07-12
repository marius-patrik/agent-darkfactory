import type { SessionMode, Usage } from "../../harness/session";

export interface StatusBarState {
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  providerIndex: number;
  modelIndex: number;
  mode: SessionMode;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  status: "idle" | "running" | "error";
  statusMessage?: string;
}

export type StatusBarAction =
  | { type: "cycle-provider" }
  | { type: "cycle-model" }
  | { type: "set-provider"; provider: string }
  | { type: "set-model"; model: string }
  | { type: "set-mode"; mode: SessionMode }
  | { type: "update-usage"; usage: Usage }
  | { type: "set-status"; status: "idle" | "running" | "error"; message?: string }
  | { type: "reset-usage" };

function configuredModels(modelsByProvider: Record<string, string[]>, provider: string): string[] {
  const models = modelsByProvider[provider];
  if (!models || models.length === 0) throw new Error(`provider ${provider} has no model in canonical config`);
  return models;
}

export function createStatusBarState(options: {
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  provider?: string;
  model?: string;
  mode?: SessionMode;
}): StatusBarState {
  const providers = options.providers;
  if (providers.length === 0 || new Set(providers).size !== providers.length) {
    throw new Error("status bar requires a non-empty unique provider list");
  }
  const selectedProvider = options.provider ?? providers[0];
  const providerIndex = providers.indexOf(selectedProvider);
  if (providerIndex === -1) throw new Error(`provider ${selectedProvider} is not in canonical config`);
  const models = configuredModels(options.modelsByProvider, selectedProvider);
  const selectedModel = options.model ?? models[0];
  const modelIndex = models.indexOf(selectedModel);
  if (modelIndex === -1) throw new Error(`model ${selectedModel} is not configured for provider ${selectedProvider}`);
  return {
    providers,
    modelsByProvider: options.modelsByProvider,
    providerIndex,
    modelIndex,
    mode: options.mode ?? "default",
    tokensIn: 0,
    tokensOut: 0,
    totalTokens: 0,
    status: "idle",
  };
}

export function statusBarReducer(state: StatusBarState, action: StatusBarAction): StatusBarState {
  switch (action.type) {
    case "cycle-provider": {
      const nextProviderIndex = (state.providerIndex + 1) % state.providers.length;
      const nextProvider = state.providers[nextProviderIndex];
      configuredModels(state.modelsByProvider, nextProvider);
      return {
        ...state,
        providerIndex: nextProviderIndex,
        modelIndex: 0,
      };
    }
    case "cycle-model": {
      const provider = state.providers[state.providerIndex];
      const models = configuredModels(state.modelsByProvider, provider);
      return {
        ...state,
        modelIndex: (state.modelIndex + 1) % models.length,
      };
    }
    case "set-provider": {
      const providerIndex = state.providers.indexOf(action.provider);
      if (providerIndex === -1) return state;
      configuredModels(state.modelsByProvider, action.provider);
      return {
        ...state,
        providerIndex,
        modelIndex: 0,
      };
    }
    case "set-model": {
      const provider = state.providers[state.providerIndex];
      const models = configuredModels(state.modelsByProvider, provider);
      const modelIndex = models.indexOf(action.model);
      if (modelIndex === -1) return state;
      return {
        ...state,
        modelIndex,
      };
    }
    case "set-mode":
      return { ...state, mode: action.mode };
    case "update-usage": {
      const tokensIn = (action.usage.tokensIn ?? 0) + state.tokensIn;
      const tokensOut = (action.usage.tokensOut ?? 0) + state.tokensOut;
      const totalTokens = (action.usage.totalTokens ?? tokensIn + tokensOut) + state.totalTokens;
      return {
        ...state,
        tokensIn,
        tokensOut,
        totalTokens,
      };
    }
    case "set-status":
      return { ...state, status: action.status, statusMessage: action.message };
    case "reset-usage":
      return { ...state, tokensIn: 0, tokensOut: 0, totalTokens: 0 };
    default:
      return state;
  }
}

export function currentProvider(state: StatusBarState): string {
  const provider = state.providers[state.providerIndex];
  if (!provider) throw new Error("status bar provider selection is invalid");
  return provider;
}

export function currentModel(state: StatusBarState): string {
  const provider = currentProvider(state);
  const model = configuredModels(state.modelsByProvider, provider)[state.modelIndex];
  if (!model) throw new Error(`status bar model selection is invalid for provider ${provider}`);
  return model;
}

export function statusBarLabel(state: StatusBarState): string {
  const provider = currentProvider(state);
  const model = currentModel(state);
  const tokens = `in=${state.tokensIn} out=${state.tokensOut} total=${state.totalTokens}`;
  const status = state.status === "running" ? "⏳" : state.status === "error" ? "⚠" : "✓";
  return `${status} ${provider}/${model} [${state.mode}] ${tokens}${state.statusMessage ? ` | ${state.statusMessage}` : ""}`;
}
