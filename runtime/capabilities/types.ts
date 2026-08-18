import type { PluginResourceOrigin } from "../plugins/index.ts";
import type { Agent, Skill } from "../resources/index.ts";
import type { WorkflowTool, WorkflowToolCatalog } from "../tools/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";

export type CapabilityGrantSource = "explicit" | "all" | "derived";

export type ResolvedCapabilityResource<T extends object> = Readonly<{
  id: string;
  resource: T;
  grant: CapabilityGrantSource;
  origin?: PluginResourceOrigin;
}>;

export type ResolvedAgentCapabilities = Readonly<{
  agent: Agent;
  tools: readonly ResolvedCapabilityResource<WorkflowTool>[];
  agents: readonly ResolvedCapabilityResource<Agent>[];
  skills: readonly ResolvedCapabilityResource<Skill>[];
}>;

export type ResolveAgentCapabilitiesInput = Readonly<{
  agent: string;
}>;

export type AgentCapabilityResolver = Readonly<{
  resolve(
    input: ResolveAgentCapabilitiesInput,
  ): Promise<ResolvedAgentCapabilities>;
}>;

export type CreateAgentCapabilityResolverOptions = Readonly<{
  registry: PluginRegistry;
  toolCatalog: WorkflowToolCatalog;
}>;
