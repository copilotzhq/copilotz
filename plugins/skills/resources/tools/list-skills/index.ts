import { mapSkills, skillManifest } from "../../../shared/snapshots.ts";
import type { ToolDefinition } from "@copilotz/copilotz/core";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/core";
import type { ActionSchema } from "@copilotz/copilotz/actions";
import {
  availableSkills,
  type SkillActionContext,
} from "../../../shared/tool-context.ts";
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
  async execute(_raw, context) {
    const skills = availableSkills(context);
    return {
      skills: await mapSkills(skills, async (skill) => {
        const manifest = await skillManifest(skill, {
          scope: context.resources,
          signal: context.signal,
        });
        return {
          name: skill.name,
          description: manifest.description,
          compatibility: manifest.compatibility,
          ...(skill.locator ? { locator: skill.locator } : {}),
          resources: skill.files.filter((file) => file.path !== "SKILL.md"),
        };
      }),
      count: skills.length,
    };
  },
});

export default listSkillsTool;
