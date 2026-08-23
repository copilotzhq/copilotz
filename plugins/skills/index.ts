export { parseSkillMarkdown, validateSkillManifest } from "./parser.ts";
export type {
  ParsedSkillMarkdown,
  ParseSkillMarkdownOptions,
} from "./parser.ts";
export {
  defineInlineSkill,
  defineSkill,
  normalizeSkillPath,
  readSkillFileText,
  skillFileMediaType,
} from "./skill.ts";
export type {
  DefineInlineSkillInput,
  DefineSkillInput,
  InlineSkillFile,
  SkillFileLoader,
} from "./skill.ts";
export { createSkillsPlugin } from "./plugin.ts";
export type { CreateSkillsPluginOptions } from "./plugin.ts";
export { SKILL_TOOL_IDS } from "./tools.ts";
export type { SkillToolId } from "./tools.ts";
export type {
  Skill,
  SkillFile,
  SkillFileBody,
  SkillFileDescriptor,
  SkillIndexEntry,
  SkillManifest,
  SkillReadOptions,
} from "@copilotz/copilotz/resources";
