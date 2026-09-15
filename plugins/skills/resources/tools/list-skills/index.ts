import type { ToolDefinition } from "@copilotz/copilotz/tools";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/tools";
import type { ActionSchema } from "@copilotz/copilotz/actions";
import {
  availableSkills,
  type SkillActionContext,
} from "../../../internal/tool-context.ts";
export const listSkillsTool: ToolDefinition<
  ActionDefinition<unknown, unknown, SkillActionContext>
> = defineTool<
  unknown,
  unknown,
  SkillActionContext,
  ActionSchema
>({
  name: "List Skills",
  description: "List skill metadata available to the calling agent.",
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

export default listSkillsTool;
