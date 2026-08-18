import type { Agent } from "../resources/index.ts";
import type { ProviderConfig } from "../llm/types.ts";
import type { ScopedPluginResources } from "../engine/index.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function requireAgent(
  resources: ScopedPluginResources,
  id: string,
): Agent {
  return resources.require<Agent>("agents", requiredText(id, "Agent id"));
}

export function agentTextBaseConfig(agent: Agent): ProviderConfig {
  const shorthand = agent.llmOptions;
  const runtime = agent.runtimes?.text;
  return {
    ...(shorthand ?? {}),
    ...(runtime
      ? {
        provider: runtime.provider as ProviderConfig["provider"],
        ...(runtime.model ? { model: runtime.model } : {}),
      }
      : {}),
  };
}

export function staticAgentTextConfig(agent: Agent): ProviderConfig {
  const config = agentTextBaseConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no text runtime provider.`);
  }
  return config;
}
