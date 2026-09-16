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
import { readSkillFileText } from "../../skill/index.ts";
import { parseSkillMarkdown } from "../../../shared/parser.ts";
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
    const markdown = await readSkillFileText(
      await skill.read("SKILL.md", { signal: context.signal }),
      maximumTextBytes(context),
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

export default loadSkillTool;
