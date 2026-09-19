/** Adds Skill reader mechanisms to the standard composed capability policy. @module */

import {
  agentCapabilities,
  type AgentCapabilitiesResource,
  type CapabilityContext,
  type ResolvedAgentCapabilities,
  type ToolResource,
} from "@copilotz/copilotz/core";
import { SKILL_TOOL_IDS } from "../../../authoring/action-resources/index.ts";
import type { Skill } from "../../../shared/contracts.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function selectedSkills(
  capabilities: ResolvedAgentCapabilities,
): readonly Skill[] {
  const explicit = new Set(capabilities.agent.capabilities?.skills ?? []);
  return capabilities.skills.map(({ resource, id }) => {
    if (!explicit.has(id)) {
      throw new Error(`Skill capability '${id}' is not explicitly granted.`);
    }
    const skill = resource as Skill;
    if (
      typeof skill.name !== "string" || skill.name !== id ||
      typeof skill.description !== "string" || !Array.isArray(skill.files) ||
      typeof skill.read !== "function"
    ) {
      throw new TypeError(`Skill capability '${id}' is not a Skill Resource.`);
    }
    return skill;
  });
}

function mechanism(
  context: CapabilityContext,
  alias: string,
): ToolResource {
  const resource = context.resources.tools?.[alias];
  const value = record(resource);
  if (
    value.action !== alias || typeof value.name !== "string" ||
    !value.name.trim() || typeof value.description !== "string" ||
    !value.description.trim()
  ) {
    throw new Error(
      `Agent grants skill capabilities, but required tool '${alias}' is not installed.`,
    );
  }
  return resource as ToolResource;
}

/**
 * Core supplies explicit grants and its generic agent mechanism. Skills adds
 * only the mechanisms required to read an already-explicit Skills grant.
 */
export const skillsCapabilities: AgentCapabilitiesResource = {
  resolve(input, context) {
    const resolved = agentCapabilities.resolve(input, context);
    const granted = selectedSkills(resolved);
    if (!granted.length) return resolved;

    const tools = [...resolved.tools];
    const append = (alias: string): void => {
      if (tools.some((tool) => tool.id === alias)) return;
      tools.push({
        id: alias,
        resource: mechanism(context, alias),
        grant: "derived",
      });
    };
    const bundled = granted.filter((skill) => !skill.locator);
    if (!bundled.length) return { ...resolved, tools } as const;
    append(SKILL_TOOL_IDS[0]);
    append(SKILL_TOOL_IDS[1]);
    if (bundled.some((skill) =>
      skill.files.some((file) => file.path !== "SKILL.md")
    )) append(SKILL_TOOL_IDS[2]);

    return { ...resolved, tools } as const;
  },
};

export default skillsCapabilities;
