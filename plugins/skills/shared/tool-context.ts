/**
 * Generates the progressive-disclosure Actions and Tool Resources for Skills.
 *
 * @module
 */

import type { ActionContext } from "@copilotz/copilotz/actions";
import type { AgentResource } from "@copilotz/copilotz/core";
import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
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
  capabilities?: Readonly<Record<string, unknown>>;
}>;

export type SkillActionContext = ActionContext<SkillActionResources>;

type FinalSkillPolicy = Readonly<{
  resolve(
    input: Readonly<{ agent: string }>,
    context: Readonly<{
      resources: RuntimeContextNamespaces;
      actions: Readonly<Record<string, unknown>>;
    }>,
  ): Readonly<{
    skills: readonly Readonly<{ id: string; resource: Skill }>[];
  }>;
}>;

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
  const metadata = context.action.metadata;
  const hasAgentId = Object.hasOwn(metadata, "agentId");
  const agentId = optionalText(metadata.agentId);
  // Direct host API calls may intentionally omit agent metadata and receive
  // the application's complete Skill set. Agent-bound calls must resolve the
  // final composed policy, including any application-root override.
  if (!hasAgentId) return values;
  // A present but malformed identifier is never treated as direct host access.
  if (!agentId) return [];
  const resolver = (context.resources as unknown as {
    capabilities?: Readonly<Record<string, FinalSkillPolicy | undefined>>;
  }).capabilities?.default;
  if (!resolver) return [];
  try {
    const resolved = resolver.resolve(
      { agent: agentId },
      {
        resources: context.resources as unknown as RuntimeContextNamespaces,
        actions: context.actions,
      },
    );
    const agent = Object.values(context.resources.agents ?? {}).find((
      candidate,
    ) => candidate?.id === agentId);
    const explicit = new Set(agent?.capabilities?.skills ?? []);
    return resolved.skills.filter(({ id }) => explicit.has(id)).map((
      { resource },
    ) => resource);
  } catch (error) {
    // A stale or forged agent identifier must never fall back to ambient
    // Skills. Configuration errors for a known agent still surface normally.
    if (
      error instanceof Error &&
      error.message.startsWith("Unknown agent context")
    ) {
      return [];
    }
    throw error;
  }
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
