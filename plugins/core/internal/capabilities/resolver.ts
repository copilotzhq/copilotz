import type { AgentResource } from "../../resources/agent/index.ts";
import type { Skill } from "@copilotz/copilotz/skills";
import type { ToolResource } from "@copilotz/copilotz/tools";
import {
  type AliasedToolResource,
  resolveAgentGrants,
  resolveSkillGrants,
  resolveToolGrants,
} from "./grants.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolEntries(
  options: CreateAgentCapabilityResolverOptions,
): readonly AliasedToolResource[] {
  return Object.freeze(
    Object.entries(options.registry.resources.tools ?? {})
      .filter((entry): entry is [string, ToolResource] =>
        entry[1] !== undefined
      )
      .map(([alias, resource]) => {
        if (
          !isRecord(resource) || resource.action !== alias ||
          typeof resource.name !== "string" || !resource.name.trim() ||
          typeof resource.description !== "string" ||
          !resource.description.trim()
        ) {
          throw new TypeError(
            `Tool Resource '${alias}' must present the same Action alias.`,
          );
        }
        if (!options.registry.actions[alias]) {
          throw new Error(
            `Tool Resource '${alias}' has no composed Action '${alias}'.`,
          );
        }
        return Object.freeze({ alias, resource });
      }),
  );
}

/** Creates canonical application/adapter introspection over effective grants. */
export function createAgentCapabilityResolver(
  options: CreateAgentCapabilityResolverOptions,
): AgentCapabilityResolver {
  return Object.freeze({
    resolve(input) {
      return Promise.resolve().then(() => {
        const id = input.agent.trim();
        if (!id) {
          throw new TypeError("Agent capability lookup requires an ID.");
        }
        const agentsContext = agentContext(options);
        const skillsContext = skillContext(options);
        const agent = agentsContext[id];
        if (!agent) throw new Error(`Unknown agent context '${id}'.`);
        const availableAgents = definedValues<AgentResource>(agentsContext);
        const availableSkills = definedValues<Skill>(skillsContext);
        const agents = resolveAgentGrants(agent, availableAgents);
        const skills = resolveSkillGrants(agent, availableSkills);
        const explicitToolKeys = new Set(agent.capabilities?.tools ?? []);
        const tools = resolveToolGrants(agent, toolEntries(options), {
          agents: availableAgents,
          skills: availableSkills,
        });
        return Object.freeze({
          agent,
          tools: Object.freeze(tools.map((tool) =>
            descriptor(
              tool.alias,
              tool.resource,
              explicitToolKeys.has(tool.alias) ? "explicit" : "derived",
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
      });
    },
  });
}
