import type { PluginResourceOrigin } from "../plugins/index.ts";
import type { Agent, Skill } from "../resources/index.ts";
import type { WorkflowTool } from "../workflows/index.ts";
import {
  capabilitySelectionMode,
  selectCapabilityResources,
} from "./selection.ts";
import { resolveAgentGrants, resolveSkillGrants } from "./grants.ts";
import type {
  AgentCapabilityResolver,
  CapabilityGrantSource,
  CreateAgentCapabilityResolverOptions,
  ResolvedCapabilityResource,
} from "./types.ts";

function generatedToolOrigin(
  options: CreateAgentCapabilityResolverOptions,
  tool: WorkflowTool,
): PluginResourceOrigin | undefined {
  const direct = options.registry.origin("tools", tool.key);
  if (direct) return direct;
  const [kind, resourceId] = tool.id.split(":", 3);
  if (kind === "api" && resourceId) {
    return options.registry.origin("apis", resourceId);
  }
  if (kind === "mcp" && resourceId) {
    return options.registry.origin("mcpServers", resourceId);
  }
  return undefined;
}

function descriptor<T extends object>(
  id: string,
  resource: T,
  grant: CapabilityGrantSource,
  origin: PluginResourceOrigin | undefined,
): ResolvedCapabilityResource<T> {
  return Object.freeze({
    id,
    resource,
    grant,
    ...(origin ? { origin } : {}),
  });
}

/** Creates canonical application/adapter introspection over effective grants. */
export function createAgentCapabilityResolver(
  options: CreateAgentCapabilityResolverOptions,
): AgentCapabilityResolver {
  return Object.freeze({
    async resolve(input) {
      const id = input.agent.trim();
      if (!id) throw new TypeError("Agent capability lookup requires an ID.");
      const agent = options.registry.require<Agent>("agents", id);
      const availableAgents = options.registry.list<Agent>("agents");
      const availableSkills = options.registry.list<Skill>("skills");
      const agents = resolveAgentGrants(agent, availableAgents);
      const skills = resolveSkillGrants(agent, availableSkills);
      const allTools = await options.toolCatalog.all(options.registry);
      const explicitTools = selectCapabilityResources({
        agentId: agent.id,
        kind: "tool",
        selection: agent.capabilities?.tools,
        resources: allTools,
        id: (tool) => tool.key,
      });
      const explicitToolKeys = new Set(explicitTools.map((tool) => tool.key));
      const tools = await options.toolCatalog.forAgent(options.registry, agent);
      const toolMode = capabilitySelectionMode(agent.capabilities?.tools);
      const agentMode = capabilitySelectionMode(agent.capabilities?.agents);
      const skillMode = capabilitySelectionMode(agent.capabilities?.skills);

      return Object.freeze({
        agent,
        tools: Object.freeze(tools.map((tool) =>
          descriptor(
            tool.key,
            tool,
            explicitToolKeys.has(tool.key)
              ? toolMode === "all" ? "all" : "explicit"
              : "derived",
            generatedToolOrigin(options, tool),
          )
        )),
        agents: Object.freeze(agents.map((candidate) =>
          descriptor(
            candidate.id,
            candidate,
            agentMode === "all" ? "all" : "explicit",
            options.registry.origin("agents", candidate.id),
          )
        )),
        skills: Object.freeze(skills.map((skill) =>
          descriptor(
            skill.name,
            skill,
            skillMode === "all" ? "all" : "explicit",
            options.registry.origin("skills", skill.name),
          )
        )),
      });
    },
  });
}
