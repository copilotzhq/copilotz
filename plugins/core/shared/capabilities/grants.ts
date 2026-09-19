import type { AgentResource } from "../../authoring/define-agent/index.ts";
import type { ToolResource } from "@copilotz/copilotz/core";
import { selectCapabilityResources } from "./selection.ts";

export const AGENT_CAPABILITY_TOOL_IDS = ["ask"] as const;

/** Core needs only a stable name to resolve an explicit Skill grant. */
export type SkillCapabilityResource = Readonly<{ name: string }>;

export type AliasedToolResource = Readonly<{
  alias: string;
  resource: ToolResource;
}>;

export function resolveAgentGrants(
  agent: AgentResource,
  agents: readonly AgentResource[],
): readonly AgentResource[] {
  return selectCapabilityResources({
    agentId: agent.id,
    kind: "agent",
    selection: agent.capabilities?.agents,
    resources: agents.filter((candidate) => candidate.id !== agent.id),
    id: (candidate) => candidate.id,
  });
}

export function resolveSkillGrants<T extends SkillCapabilityResource>(
  agent: AgentResource,
  skills: readonly T[],
): readonly T[] {
  return selectCapabilityResources({
    agentId: agent.id,
    kind: "skill",
    selection: agent.capabilities?.skills,
    resources: skills,
    id: (skill) => skill.name,
  });
}

function requireMechanismTool<T extends AliasedToolResource>(
  agent: AgentResource,
  toolsByKey: ReadonlyMap<string, T>,
  key: string,
  capability: "agent" | "skill",
): T {
  const tool = toolsByKey.get(key);
  if (!tool) {
    throw new Error(
      `Agent '${agent.id}' grants ${capability} capabilities, but required tool '${key}' is not installed.`,
    );
  }
  return tool;
}

/** Resolves explicit tools and derives framework mechanism tools from grants. */
export function resolveToolGrants<T extends AliasedToolResource>(
  agent: AgentResource,
  tools: readonly T[],
  resources: Readonly<{
    agents: readonly AgentResource[];
  }>,
): readonly T[] {
  const selected = [...selectCapabilityResources({
    agentId: agent.id,
    kind: "tool",
    selection: agent.capabilities?.tools,
    resources: tools,
    id: (tool) => tool.alias,
  })];
  const selectedKeys = new Set(selected.map((tool) => tool.alias));
  const toolsByKey = new Map(tools.map((tool) => [tool.alias, tool]));
  const append = (tool: T): void => {
    if (selectedKeys.has(tool.alias)) return;
    selectedKeys.add(tool.alias);
    selected.push(tool);
  };

  if (resolveAgentGrants(agent, resources.agents).length > 0) {
    append(requireMechanismTool(agent, toolsByKey, "ask", "agent"));
  }

  return selected;
}
