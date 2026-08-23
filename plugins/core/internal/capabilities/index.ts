export { createAgentCapabilityResolver } from "./resolver.ts";
export {
  AGENT_CAPABILITY_TOOL_IDS,
  resolveAgentGrants,
  resolveSkillGrants,
  resolveToolGrants,
  SKILL_CAPABILITY_TOOL_IDS,
} from "./grants.ts";
export {
  capabilitySelectionMode,
  selectCapabilityResources,
} from "./selection.ts";
export type {
  AgentCapabilityResolver,
  CapabilityGrantSource,
  CreateAgentCapabilityResolverOptions,
  ResolveAgentCapabilitiesInput,
  ResolvedAgentCapabilities,
  ResolvedCapabilityResource,
} from "./types.ts";
