import type { ToolDefinition } from "@copilotz/copilotz/core";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/core";
import type { ActionSchema } from "@copilotz/copilotz/actions";
import {
  maximumTextBytes,
  record,
  type SkillActionContext,
  skillByName,
} from "../../../shared/tool-context.ts";
export const loadSkillTool: ToolDefinition<
  ActionDefinition<unknown, unknown, SkillActionContext>
> = defineTool<
  unknown,
  unknown,
  SkillActionContext,
  ActionSchema
>({
  name: "Load Skill",
  description: "Load the complete instructions for an available skill.",
  id: "copilotz.skills.load_skill",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
  },
  async execute(raw, context) {
    const skill = skillByName(context, record(raw).name);
    const options = {
      signal: context.signal,
      scope: context.resources,
      maximumTextBytes: maximumTextBytes(context),
    };
    const parsed = await skill.load(options);
    return {
      name: skill.name,
      description: parsed.manifest.description,
      content: parsed.body,
      compatibility: parsed.manifest.compatibility,
      allowedTools: parsed.manifest.allowedTools,
      resources: skill.files.filter((file) => file.path !== "SKILL.md"),
    };
  },
});

export default loadSkillTool;
