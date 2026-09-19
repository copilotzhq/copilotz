import type { ToolDefinition } from "@copilotz/copilotz/core";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/core";
import type { ActionSchema } from "@copilotz/copilotz/actions";
import {
  maximumTextBytes,
  record,
  requiredText,
  type SkillActionContext,
  skillByName,
} from "../../../shared/tool-context.ts";
import { isTextMediaType } from "../../../shared/media.ts";
import { normalizeSkillPath, readSkillFileText } from "../../skill/index.ts";
export const readSkillResourceTool: ToolDefinition<
  ActionDefinition<unknown, unknown, SkillActionContext>
> = defineTool<
  unknown,
  unknown,
  SkillActionContext,
  ActionSchema
>({
  name: "Read Skill Resource",
  description: "Read one supporting file from an available skill bundle.",
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
    const descriptor = skill.files.find((file) => file.path === path);
    if (descriptor && !isTextMediaType(descriptor.mediaType)) {
      throw new TypeError(
        `Skill resource '${path}' is binary and cannot be read as text.`,
      );
    }
    const file = await skill.read(path, { signal: context.signal });
    if (!isTextMediaType(file.mediaType)) {
      throw new TypeError(
        `Skill resource '${path}' is binary and cannot be read as text.`,
      );
    }
    return {
      skill: skill.name,
      path,
      mediaType: file.mediaType,
      content: await readSkillFileText(
        file,
        maximumTextBytes(context),
        context.signal,
      ),
    };
  },
});

export default readSkillResourceTool;
