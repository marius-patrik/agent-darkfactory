import { adapterIds } from "../adapters";

export const defaultProviderModels: Record<string, string[]> = {
  kimi: ["kimi-k2", "moonshot-v1-8k", "moonshot-v1-32k"],
  claude: ["claude-sonnet-4-20250514", "claude-opus-4"],
  codex: ["codex-latest"],
  agy: ["gemini-2.5-pro", "gemini-2.5-flash"],
  fake: ["test"],
};

export function configuredProviderModels(): { providers: string[]; modelsByProvider: Record<string, string[]> } {
  const providers = adapterIds();
  const modelsByProvider: Record<string, string[]> = {};
  for (const provider of providers) {
    modelsByProvider[provider] = defaultProviderModels[provider] ?? ["default"];
  }
  return { providers, modelsByProvider };
}
