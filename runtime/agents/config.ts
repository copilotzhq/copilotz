import type {
  Agent,
  AgentRuntime,
  AgentRuntimeMode,
} from "../resources/index.ts";
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

function runtimeMode(runtime: AgentRuntime): AgentRuntimeMode {
  return runtime.mode ?? "generate";
}

function agentRuntimeList(agent: Agent): readonly AgentRuntime[] {
  const value = agent.runtime;
  if (value == null) return [];
  return Array.isArray(value) ? value : [value as AgentRuntime];
}

export function resolveAgentRuntime(
  agent: Agent,
  mode: AgentRuntimeMode = "generate",
): AgentRuntime | undefined {
  const selected = agentRuntimeList(agent).filter((runtime) =>
    runtimeMode(runtime) === mode
  );
  if (selected.length > 1) {
    throw new Error(
      `Agent '${agent.id}' declares more than one ${mode} runtime.`,
    );
  }
  return selected[0];
}

function agentRuntimeToProviderConfig(
  runtime: AgentRuntime,
): ProviderConfig {
  const {
    mode: _mode,
    input: _input,
    output: _output,
    options: _options,
    voice: _voice,
    fallbacks,
    ...config
  } = runtime;
  return {
    ...config,
    provider: runtime.provider as ProviderConfig["provider"],
    ...(fallbacks ? { fallbacks: [...fallbacks] } : {}),
  };
}

export function agentTextBaseConfig(agent: Agent): ProviderConfig {
  const runtime = resolveAgentRuntime(agent, "generate");
  return runtime ? agentRuntimeToProviderConfig(runtime) : {};
}

export function agentSessionBaseConfig(agent: Agent): ProviderConfig {
  const runtime = resolveAgentRuntime(agent, "session");
  return runtime ? agentRuntimeToProviderConfig(runtime) : {};
}

/** True when the agent is session-only (no generate runtime). */
export function agentUsesSessionRuntime(agent: Agent): boolean {
  return Boolean(resolveAgentRuntime(agent, "session")) &&
    !resolveAgentRuntime(agent, "generate");
}

export function staticAgentTextConfig(agent: Agent): ProviderConfig {
  const config = agentTextBaseConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no generate runtime provider.`);
  }
  return config;
}

export function staticAgentSessionConfig(agent: Agent): ProviderConfig {
  const config = agentSessionBaseConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no session runtime provider.`);
  }
  return config;
}
