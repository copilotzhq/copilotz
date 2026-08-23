import type { AgentResource } from "../../agent.ts";
import type { Skill } from "@copilotz/copilotz/skills";
import type {
  WorkflowTool,
  WorkflowToolCatalog,
} from "@copilotz/copilotz/tools";
import type { PluginRegistry } from "@copilotz/copilotz/plugins";

export type CapabilityGrantSource = "explicit" | "derived";

export type ResolvedCapabilityResource<T extends object> = Readonly<{
  id: string;
  resource: T;
  grant: CapabilityGrantSource;
}>;

export type ResolvedAgentCapabilities = Readonly<{
  agent: AgentResource;
  tools: readonly ResolvedCapabilityResource<WorkflowTool>[];
  agents: readonly ResolvedCapabilityResource<AgentResource>[];
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
