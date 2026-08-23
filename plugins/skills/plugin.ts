import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { Skill } from "./contracts.ts";
import {
  createSkillActionResources,
  SKILL_TOOL_IDS,
  type SkillToolId,
} from "./tools.ts";

export type CreateSkillsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  skills: readonly Skill[];
  /** False contributes only resources. The default includes progressive-disclosure tools. */
  tools?: false | readonly SkillToolId[];
  maximumTextBytes?: number;
}>;

/** Packages portable Agent Skills resources and their progressive-disclosure tools. */
export function createSkillsPlugin(
  options: CreateSkillsPluginOptions,
): CopilotzPlugin {
  if (!Array.isArray(options.skills)) {
    throw new TypeError("Skills plugin resources must be an array.");
  }
  const skills = options.skills as readonly Skill[];
  const defaultTools: readonly SkillToolId[] =
    skills.some((skill) => skill.files.some((file) => file.path !== "SKILL.md"))
      ? SKILL_TOOL_IDS
      : SKILL_TOOL_IDS.filter((id) => id !== "read_skill_resource");
  const toolIds = options.tools === false
    ? Object.freeze([]) as readonly SkillToolId[]
    : Object.freeze([...(options.tools ?? defaultTools)]);
  if (new Set(toolIds).size !== toolIds.length) {
    throw new TypeError("Skills plugin tool selection contains duplicate IDs.");
  }
  const known = new Set<string>(SKILL_TOOL_IDS);
  const unknown = toolIds.find((id) => !known.has(id));
  if (unknown) throw new TypeError(`Unknown skill tool '${unknown}'.`);
  const contribution = createSkillActionResources({
    include: toolIds,
    maximumTextBytes: options.maximumTextBytes,
  });
  return definePlugin({
    id: options.id ?? "@copilotz/skills",
    version: options.version ?? "0.57.0",
    actions: contribution.actions,
    resources: {
      skills: Object.fromEntries(skills.map((skill) => [skill.name, skill])),
      ...(Object.keys(contribution.tools).length
        ? { tools: contribution.tools }
        : {}),
    },
  });
}
