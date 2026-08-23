import type { AgentResource } from "../../agent.ts";
import type { Skill } from "@copilotz/copilotz/skills";
import type { WorkflowToolCatalogContext } from "@copilotz/copilotz/tools";
import { selectCapabilityResources } from "./selection.ts";
import { resolveAgentGrants, resolveSkillGrants } from "./grants.ts";
import type {
  AgentCapabilityResolver,
  CapabilityGrantSource,
  CreateAgentCapabilityResolverOptions,
  ResolvedCapabilityResource,
} from "./types.ts";

function definedValues<T>(
  values: Readonly<Record<string, T | undefined>> | undefined,
): readonly T[] {
  return Object.freeze(
    Object.values(values ?? {}).filter((value): value is T =>
      value !== undefined
    ),
  );
}

function agentContext(
  options: CreateAgentCapabilityResolverOptions,
): Readonly<Record<string, AgentResource | undefined>> {
  return (options.registry.resources.agents ?? {}) as Readonly<
    Record<string, AgentResource | undefined>
  >;
}

function skillContext(
  options: CreateAgentCapabilityResolverOptions,
): Readonly<Record<string, Skill | undefined>> {
  return (options.registry.resources.skills ?? {}) as Readonly<
    Record<string, Skill | undefined>
  >;
}

function descriptor<T extends object>(
  id: string,
  resource: T,
  grant: CapabilityGrantSource,
): ResolvedCapabilityResource<T> {
  return Object.freeze({
    id,
    resource,
    grant,
  });
}

function catalogContext(
  options: CreateAgentCapabilityResolverOptions,
): WorkflowToolCatalogContext {
  return Object.freeze({
    agents: Object.freeze({ ...(options.registry.resources.agents ?? {}) }),
    skills: Object.freeze({ ...(options.registry.resources.skills ?? {}) }),
    tools: Object.freeze({ ...(options.registry.resources.tools ?? {}) }),
    apis: Object.freeze({ ...(options.registry.resources.apis ?? {}) }),
    mcp: Object.freeze({ ...(options.registry.resources.mcp ?? {}) }),
  }) as unknown as WorkflowToolCatalogContext;
}

/** Creates canonical application/adapter introspection over effective grants. */
export function createAgentCapabilityResolver(
  options: CreateAgentCapabilityResolverOptions,
): AgentCapabilityResolver {
  return Object.freeze({
    async resolve(input) {
      const id = input.agent.trim();
      if (!id) throw new TypeError("Agent capability lookup requires an ID.");
      const agentsContext = agentContext(options);
      const skillsContext = skillContext(options);
      const agent = agentsContext[id];
      if (!agent) throw new Error(`Unknown agent context '${id}'.`);
      const availableAgents = definedValues<AgentResource>(agentsContext);
      const availableSkills = definedValues<Skill>(skillsContext);
      const agents = resolveAgentGrants(agent, availableAgents);
      const skills = resolveSkillGrants(agent, availableSkills);
      const toolContext = catalogContext(options);
      const allTools = await options.toolCatalog.all(toolContext);
      const explicitTools = selectCapabilityResources({
        agentId: agent.id,
        kind: "tool",
        selection: agent.capabilities?.tools,
        resources: allTools,
        id: (tool) => tool.key,
      });
      const explicitToolKeys = new Set(explicitTools.map((tool) => tool.key));
      const tools = await options.toolCatalog.forAgent(toolContext, agent);
      return Object.freeze({
        agent,
        tools: Object.freeze(tools.map((tool) =>
          descriptor(
            tool.key,
            tool,
            explicitToolKeys.has(tool.key) ? "explicit" : "derived",
          )
        )),
        agents: Object.freeze(agents.map((candidate) =>
          descriptor(
            candidate.id,
            candidate,
            "explicit",
          )
        )),
        skills: Object.freeze(skills.map((skill) =>
          descriptor(
            skill.name,
            skill,
            "explicit",
          )
        )),
      });
    },
  });
}
