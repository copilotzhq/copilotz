import type { AgentResource } from "../../agent.ts";
import type { Skill } from "@copilotz/copilotz/skills";
import { selectCapabilityResources } from "./selection.ts";

export const AGENT_CAPABILITY_TOOL_IDS = ["ask"] as const;
export const SKILL_CAPABILITY_TOOL_IDS = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
] as const;

type KeyedTool = Readonly<{ key: string }>;

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

export function resolveSkillGrants(
  agent: AgentResource,
  skills: readonly Skill[],
): readonly Skill[] {
  return selectCapabilityResources({
    agentId: agent.id,
    kind: "skill",
    selection: agent.capabilities?.skills,
    resources: skills,
    id: (skill) => skill.name,
  });
}

function requireMechanismTool<T extends KeyedTool>(
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
export function resolveToolGrants<T extends KeyedTool>(
  agent: AgentResource,
  tools: readonly T[],
  resources: Readonly<{
    agents: readonly AgentResource[];
    skills: readonly Skill[];
  }>,
): readonly T[] {
  const selected = [...selectCapabilityResources({
    agentId: agent.id,
    kind: "tool",
    selection: agent.capabilities?.tools,
    resources: tools,
    id: (tool) => tool.key,
  })];
  const selectedKeys = new Set(selected.map((tool) => tool.key));
  const toolsByKey = new Map(tools.map((tool) => [tool.key, tool]));
  const append = (tool: T): void => {
    if (selectedKeys.has(tool.key)) return;
    selectedKeys.add(tool.key);
    selected.push(tool);
  };

  if (resolveAgentGrants(agent, resources.agents).length > 0) {
    append(requireMechanismTool(agent, toolsByKey, "ask", "agent"));
  }

  const skills = resolveSkillGrants(agent, resources.skills);
  if (skills.length > 0) {
    append(requireMechanismTool(agent, toolsByKey, "list_skills", "skill"));
    append(requireMechanismTool(agent, toolsByKey, "load_skill", "skill"));
    const needsResources = skills.some((skill) =>
      skill.files.some((file) => file.path !== "SKILL.md")
    );
    const readResource = toolsByKey.get("read_skill_resource");
    if (needsResources) {
      append(requireMechanismTool(
        agent,
        toolsByKey,
        "read_skill_resource",
        "skill",
      ));
    } else if (readResource) {
      append(readResource);
    }
  }

  return Object.freeze(selected);
}
