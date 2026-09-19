import type { AgentResource } from "../../../authoring/define-agent/index.ts";
import type { ToolResource } from "@copilotz/copilotz/core";
import {
  type AliasedToolResource,
  resolveAgentGrants,
  resolveSkillGrants,
  resolveToolGrants,
  type SkillCapabilityResource,
} from "../../../shared/capabilities/grants.ts";
import type {
  AgentCapabilitiesResource,
  CapabilityContext,
  CapabilityGrantSource,
  ResolvedCapabilityResource,
} from "./types.ts";

function definedValues<T>(
  values: Readonly<Record<string, T | undefined>> | undefined,
): readonly T[] {
  return (Object.values(values ?? {}).filter((value): value is T =>
    value !== undefined
  ));
}

function agentContext(
  options: CapabilityContext,
): Readonly<Record<string, AgentResource | undefined>> {
  return (options.resources.agents ?? {}) as Readonly<
    Record<string, AgentResource | undefined>
  >;
}

function skillContext(
  options: CapabilityContext,
): Readonly<Record<string, SkillCapabilityResource | undefined>> {
  return (options.resources.skills ?? {}) as Readonly<
    Record<string, SkillCapabilityResource | undefined>
  >;
}

function descriptor<T extends object>(
  id: string,
  resource: T,
  grant: CapabilityGrantSource,
): ResolvedCapabilityResource<T> {
  return ({
    id,
    resource,
    grant,
  } as const);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolEntries(
  options: CapabilityContext,
): readonly AliasedToolResource[] {
  return (Object.entries(options.resources.tools ?? {})
    .filter((entry): entry is [string, ToolResource] => entry[1] !== undefined)
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
      return ({ alias, resource } as const);
    }));
}

/** Resolves effective grants from the final invocation context. */
export const agentCapabilities: AgentCapabilitiesResource = {
  resolve(input, options) {
    const id = input.agent.trim();
    if (!id) {
      throw new TypeError("Agent capability lookup requires an ID.");
    }
    const agentsContext = agentContext(options);
    const skillsContext = skillContext(options);
    // Resource aliases are composition keys; durable metadata carries the
    // stable Agent resource ID. Resolve by ID so an alias rename cannot turn a
    // valid Agent into an unknown context or accidentally widen access.
    const agent = Object.values(agentsContext).find((candidate) =>
      candidate?.id === id
    );
    if (!agent) throw new Error(`Unknown agent context '${id}'.`);
    const availableAgents = definedValues<AgentResource>(agentsContext);
    const availableSkills = definedValues<SkillCapabilityResource>(
      skillsContext,
    );
    const agents = resolveAgentGrants(agent, availableAgents);
    const skills = resolveSkillGrants(agent, availableSkills);
    const explicitToolKeys = new Set(agent.capabilities?.tools ?? []);
    // Resolve declarations against every composed Tool Resource so unknown
    // grants fail closed. Callable availability is enforced at the invocation
    // boundary; this resource remains an honest description of the selected
    // policy even during durable recovery with a partial caller map.
    const tools = resolveToolGrants(agent, toolEntries(options), {
      agents: availableAgents,
    });
    return ({
      agent,
      tools: tools.map((tool) =>
        descriptor(
          tool.alias,
          tool.resource,
          explicitToolKeys.has(tool.alias) ? "explicit" : "derived",
        )
      ),
      agents: agents.map((candidate) =>
        descriptor(
          candidate.id,
          candidate,
          "explicit",
        )
      ),
      skills: skills.map((skill) =>
        descriptor(
          skill.name,
          skill,
          "explicit",
        )
      ),
    } as const);
  },
};

export default agentCapabilities;
export type * from "./types.ts";
