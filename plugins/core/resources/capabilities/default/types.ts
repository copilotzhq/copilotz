import type { AgentResource } from "../../../authoring/define-agent/index.ts";
import type { ToolResource } from "@copilotz/copilotz/core";
import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
import type { SkillCapabilityResource } from "../../../shared/capabilities/grants.ts";

export type CapabilityGrantSource = "explicit" | "derived";

export type ResolvedCapabilityResource<T extends object> = Readonly<{
  id: string;
  resource: T;
  grant: CapabilityGrantSource;
}>;

export type ResolvedAgentCapabilities = Readonly<{
  agent: AgentResource;
  tools: readonly ResolvedCapabilityResource<ToolResource>[];
  agents: readonly ResolvedCapabilityResource<AgentResource>[];
  skills: readonly ResolvedCapabilityResource<SkillCapabilityResource>[];
}>;

export type ResolveAgentCapabilitiesInput = Readonly<{
  agent: string;
}>;

export type AgentCapabilitiesResource = Readonly<{
  resolve(
    input: ResolveAgentCapabilitiesInput,
    context: CapabilityContext,
  ): ResolvedAgentCapabilities;
}>;

export type CapabilityContext = Readonly<{
  resources: RuntimeContextNamespaces;
  actions: Readonly<Record<string, unknown>>;
}>;
