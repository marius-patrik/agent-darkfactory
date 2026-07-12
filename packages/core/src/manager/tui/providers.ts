import { adapterIds } from "../adapters";
import type { SessionConfig } from "../state";
import type { SessionDescriptor } from "../../harness/session";

export function configuredProviderModels(
  config: SessionConfig,
  active?: Pick<SessionDescriptor, "provider" | "model">,
): { providers: string[]; modelsByProvider: Record<string, string[]> } {
  const knownProviders = new Set<string>(adapterIds());
  const modelsByProvider: Record<string, string[]> = structuredClone(config.providerModels ?? {});
  if (config.defaultProvider && config.defaultModel) {
    knownProviders.add(config.defaultProvider);
    const models = modelsByProvider[config.defaultProvider] ?? [];
    if (!models.includes(config.defaultModel)) modelsByProvider[config.defaultProvider] = [...models, config.defaultModel];
  }
  if (active) {
    knownProviders.add(active.provider);
    const models = modelsByProvider[active.provider] ?? [];
    if (!models.includes(active.model)) modelsByProvider[active.provider] = [...models, active.model];
  }
  const providers = [...knownProviders].filter((provider) => (modelsByProvider[provider]?.length ?? 0) > 0);
  return { providers, modelsByProvider };
}
