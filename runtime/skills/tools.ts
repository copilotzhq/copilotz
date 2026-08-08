import { resolveSkillGrants } from "../capabilities/index.ts";
import type { Agent, Skill } from "../resources/index.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../workflows/index.ts";
import { normalizeSkillPath, readSkillFileText } from "./skill.ts";
import { parseSkillMarkdown } from "./parser.ts";

export const SKILL_TOOL_IDS = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
] as const;

export type SkillToolId = typeof SKILL_TOOL_IDS[number];

export type CreateSkillToolsOptions = Readonly<{
  include: readonly SkillToolId[];
  maximumTextBytes?: number;
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

function context(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("This tool requires an event-native Copilotz context.");
  }
  return value;
}

function defineTool(input: Omit<WorkflowTool, "id">): WorkflowTool {
  return Object.freeze({ ...input, id: input.key }) as WorkflowTool;
}

function availableSkills(ctx: WorkflowToolExecutionContext): readonly Skill[] {
  const values = ctx.processor.resources.list<Skill>("skills");
  const agent = ctx.agent ??
    (ctx.execution.agentId
      ? ctx.processor.resources.get<Agent>("agents", ctx.execution.agentId)
      : undefined);
  if (!agent) return values;
  return resolveSkillGrants(agent, values);
}

function skillByName(
  ctx: WorkflowToolExecutionContext,
  value: unknown,
): Skill {
  const name = requiredText(value, "Skill name");
  const skill = availableSkills(ctx).find((candidate) =>
    candidate.name === name
  );
  if (!skill) {
    throw new Error(`Skill '${name}' is not available to this agent.`);
  }
  return skill;
}

function listSkillsTool(): WorkflowTool {
  return defineTool({
    key: "list_skills",
    name: "List Skills",
    description: "List skill metadata available to the calling agent.",
    inputSchema: { type: "object", properties: {} },
    execute: (_raw, value) => {
      const skills = availableSkills(context(value));
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
}

function loadSkillTool(maximumTextBytes: number): WorkflowTool {
  return defineTool({
    key: "load_skill",
    name: "Load Skill",
    description: "Load the complete instructions for an available skill.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const skill = skillByName(ctx, record(raw).name);
      const markdown = await readSkillFileText(
        await skill.read("SKILL.md", { signal: ctx.processor.signal }),
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
}

function readSkillResourceTool(maximumTextBytes: number): WorkflowTool {
  return defineTool({
    key: "read_skill_resource",
    name: "Read Skill Resource",
    description: "Read one supporting file from an available skill bundle.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
      required: ["skill", "path"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const skill = skillByName(ctx, input.skill);
      const path = normalizeSkillPath(requiredText(input.path, "Skill path"));
      if (path === "SKILL.md") {
        throw new TypeError("Use load_skill to load SKILL.md instructions.");
      }
      const file = await skill.read(path, { signal: ctx.processor.signal });
      return {
        skill: skill.name,
        path,
        mediaType: file.mediaType,
        content: await readSkillFileText(file, maximumTextBytes),
      };
    },
  });
}

/** Creates plugin-owned skill tools without importing host capabilities. */
export function createSkillTools(
  options: CreateSkillToolsOptions,
): readonly WorkflowTool[] {
  const maximumTextBytes = options.maximumTextBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maximumTextBytes) || maximumTextBytes < 1) {
    throw new TypeError("maximumTextBytes must be a positive safe integer.");
  }
  const factories: Readonly<Record<SkillToolId, () => WorkflowTool>> = {
    list_skills: listSkillsTool,
    load_skill: () => loadSkillTool(maximumTextBytes),
    read_skill_resource: () => readSkillResourceTool(maximumTextBytes),
  };
  return Object.freeze(options.include.map((id) => factories[id]()));
}
