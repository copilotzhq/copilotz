/**
 * Generates the progressive-disclosure Actions and Tool Resources for Skills.
 *
 * @module
 */

import {
  type ActionContext,
  type ActionSchema,
  type AnyActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type AgentResource,
  resolveSkillGrants,
} from "@copilotz/copilotz/core";
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { Skill } from "../../internal/contracts.ts";
import { parseSkillMarkdown } from "../../resources/skill/internal/parser.ts";
import {
  normalizeSkillPath,
  readSkillFileText,
} from "../../resources/skill/index.ts";

export const SKILL_TOOL_IDS = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
] as const;

export type SkillToolId = typeof SKILL_TOOL_IDS[number];

export type CreateSkillActionResourcesOptions = Readonly<{
  include: readonly SkillToolId[];
  maximumTextBytes?: number;
}>;

type SkillActionResources = Readonly<{
  skills: Readonly<Record<string, Skill | undefined>>;
  agents?: Readonly<Record<string, AgentResource | undefined>>;
}>;

type SkillActionContext = ActionContext<SkillActionResources>;

export type SkillActionResourcesContribution = Readonly<{
  actions: Readonly<Record<string, AnyActionDefinition>>;
  tools: Readonly<Record<string, ToolResource>>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function availableSkills(context: SkillActionContext): readonly Skill[] {
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

function skillByName(
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

function allSkillActions(maximumTextBytes: number) {
  const listSkills = defineAction<
    unknown,
    unknown,
    SkillActionContext,
    ActionSchema
  >({
    id: "copilotz.skills.list_skills",
    inputSchema: { type: "object", properties: {} },
    execute(_raw, context) {
      const skills = availableSkills(context);
      return {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          compatibility: skill.compatibility,
          resources: skill.files.filter((file) => file.path !== "SKILL.md"),
        })),
        count: skills.length,
      };
    },
  });

  const loadSkill = defineAction<
    unknown,
    unknown,
    SkillActionContext,
    ActionSchema
  >({
    id: "copilotz.skills.load_skill",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    },
    async execute(raw, context) {
      const skill = skillByName(context, record(raw).name);
      const markdown = await readSkillFileText(
        await skill.read("SKILL.md", { signal: context.signal }),
        maximumTextBytes,
      );
      const parsed = parseSkillMarkdown(markdown);
      if (
        parsed.manifest.name !== skill.name ||
        parsed.manifest.description !== skill.description
      ) {
        throw new Error(
          `Skill '${skill.name}' catalog metadata does not match SKILL.md.`,
        );
      }
      return {
        name: skill.name,
        description: skill.description,
        content: parsed.body,
        compatibility: skill.compatibility,
        allowedTools: skill.allowedTools,
        resources: skill.files.filter((file) => file.path !== "SKILL.md"),
      };
    },
  });

  const readSkillResource = defineAction<
    unknown,
    unknown,
    SkillActionContext,
    ActionSchema
  >({
    id: "copilotz.skills.read_skill_resource",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
      required: ["skill", "path"],
    },
    async execute(raw, context) {
      const input = record(raw);
      const skill = skillByName(context, input.skill);
      const path = normalizeSkillPath(requiredText(input.path, "Skill path"));
      if (path === "SKILL.md") {
        throw new TypeError("Use load_skill to load SKILL.md instructions.");
      }
      const file = await skill.read(path, { signal: context.signal });
      return {
        skill: skill.name,
        path,
        mediaType: file.mediaType,
        content: await readSkillFileText(file, maximumTextBytes),
      };
    },
  });

  return Object.freeze({
    list_skills: Object.freeze({
      action: listSkills,
      presentation: Object.freeze({
        name: "List Skills",
        description: "List skill metadata available to the calling agent.",
      }),
    }),
    load_skill: Object.freeze({
      action: loadSkill,
      presentation: Object.freeze({
        name: "Load Skill",
        description: "Load the complete instructions for an available skill.",
      }),
    }),
    read_skill_resource: Object.freeze({
      action: readSkillResource,
      presentation: Object.freeze({
        name: "Read Skill Resource",
        description: "Read one supporting file from an available skill bundle.",
      }),
    }),
  });
}

/** Builds selected native Actions and their matching data-only Tool Resources. */
export function createSkillActionResources(
  options: CreateSkillActionResourcesOptions,
): SkillActionResourcesContribution {
  const maximumTextBytes = options.maximumTextBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maximumTextBytes) || maximumTextBytes < 1) {
    throw new TypeError("maximumTextBytes must be a positive safe integer.");
  }
  const definitions = allSkillActions(maximumTextBytes);
  const actions: Record<string, AnyActionDefinition> = {};
  const tools: Record<string, ToolResource> = {};
  for (const id of options.include) {
    const definition = definitions[id];
    actions[id] = definition.action;
    tools[id] = defineTool(id, definition.action, definition.presentation);
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    tools: Object.freeze(tools),
  });
}
