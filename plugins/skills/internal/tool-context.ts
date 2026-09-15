/**
 * Generates the progressive-disclosure Actions and Tool Resources for Skills.
 *
 * @module
 */

import type { ActionContext } from "@copilotz/copilotz/actions";
import {
  type AgentResource,
  resolveSkillGrants,
} from "@copilotz/copilotz/core";
import type { Skill } from "./contracts.ts";

export const SKILL_TOOL_IDS = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
] as const;

export type SkillToolId = typeof SKILL_TOOL_IDS[number];

type SkillActionResources = Readonly<{
  skillConfig?: Readonly<{ default?: Readonly<{ maximumTextBytes?: number }> }>;
  skills: Readonly<Record<string, Skill | undefined>>;
  agents?: Readonly<Record<string, AgentResource | undefined>>;
}>;

export type SkillActionContext = ActionContext<SkillActionResources>;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function availableSkills(context: SkillActionContext): readonly Skill[] {
  const values = Object.values(context.resources.skills ?? {}).filter(
    (value): value is Skill => !!value,
  );
  const agentId = optionalText(context.action.metadata.agentId);
  if (!agentId) return values;
  const agent = Object.values(context.resources.agents ?? {}).find((
    candidate,
  ) => candidate?.id === agentId);
  return agent ? resolveSkillGrants(agent, values) : values;
}

export function skillByName(
  context: SkillActionContext,
  value: unknown,
): Skill {
  const name = requiredText(value, "Skill name");
  const skill = availableSkills(context).find((candidate) =>
    candidate.name === name
  );
  if (!skill) {
    throw new Error(`Skill '${name}' is not available to this agent.`);
  }
  return skill;
}

export function maximumTextBytes(context: SkillActionContext): number {
  const value = context.resources.skillConfig?.default?.maximumTextBytes ??
    1_000_000;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumTextBytes must be a positive safe integer.");
  }
  return value;
}
