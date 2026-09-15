export { listSkillsTool } from "../../resources/tools/list-skills/index.ts";
export { loadSkillTool } from "../../resources/tools/load-skill/index.ts";
export { readSkillResourceTool } from "../../resources/tools/read-skill-resource/index.ts";
export const SKILL_TOOL_IDS = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
] as const;
export type SkillToolId = typeof SKILL_TOOL_IDS[number];
