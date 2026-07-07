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

export function createStatusBarState(options: {
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  provider?: string;
  model?: string;
  mode?: SessionMode;
}): StatusBarState {
  const providers = options.providers.length > 0 ? options.providers : ["fake"];
  const modelsByProvider = Object.keys(options.modelsByProvider).length > 0 ? options.modelsByProvider : { fake: ["test"] };
  const providerIndex = Math.max(
    0,
    providers.findIndex((p) => p === (options.provider ?? providers[0])),
  );
  const models = modelsByProvider[providers[providerIndex]] ?? ["default"];
  const modelIndex = Math.max(
    0,
    models.findIndex((m) => m === (options.model ?? models[0])),
  );
  return {
    providers,
    modelsByProvider,
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
      const nextModels = state.modelsByProvider[nextProvider] ?? ["default"];
      return {
        ...state,
        providerIndex: nextProviderIndex,
        modelIndex: 0,
      };
    }
    case "cycle-model": {
      const provider = state.providers[state.providerIndex];
      const models = state.modelsByProvider[provider] ?? ["default"];
      return {
        ...state,
        modelIndex: (state.modelIndex + 1) % models.length,
      };
    }
    case "set-provider": {
      const providerIndex = state.providers.indexOf(action.provider);
      if (providerIndex === -1) return state;
      const models = state.modelsByProvider[action.provider] ?? ["default"];
      return {
        ...state,
        providerIndex,
        modelIndex: 0,
      };
    }
    case "set-model": {
      const provider = state.providers[state.providerIndex];
      const models = state.modelsByProvider[provider] ?? ["default"];
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
  return state.providers[state.providerIndex] ?? "unknown";
}

export function currentModel(state: StatusBarState): string {
  const provider = currentProvider(state);
  const models = state.modelsByProvider[provider] ?? ["default"];
  return models[state.modelIndex] ?? "default";
}

export function statusBarLabel(state: StatusBarState): string {
  const provider = currentProvider(state);
  const model = currentModel(state);
  const tokens = `in=${state.tokensIn} out=${state.tokensOut} total=${state.totalTokens}`;
  const status = state.status === "running" ? "⏳" : state.status === "error" ? "⚠" : "✓";
  return `${status} ${provider}/${model} [${state.mode}] ${tokens}${state.statusMessage ? ` | ${state.statusMessage}` : ""}`;
}
