/**
 * Exposes the public Skills plugin, Resources, and authoring helpers.
 *
 * @module
 */

export {
  parseSkillMarkdown,
  validateSkillManifest,
} from "./resources/index.ts";
export type {
  ParsedSkillMarkdown,
  ParseSkillMarkdownOptions,
} from "./resources/index.ts";
export {
  defineInlineSkill,
  defineSkill,
  normalizeSkillPath,
  readSkillFileText,
  skillFileMediaType,
} from "./resources/index.ts";
export type {
  DefineInlineSkillInput,
  DefineSkillInput,
  InlineSkillFile,
  SkillFileLoader,
} from "./resources/index.ts";
export { skillsPlugin } from "./plugin.ts";
export { SKILL_TOOL_IDS } from "./authoring/index.ts";
export type { SkillToolId } from "./authoring/index.ts";
export type {
  Skill,
  SkillFile,
  SkillFileBody,
  SkillFileDescriptor,
  SkillIndexEntry,
  SkillManifest,
  SkillReadOptions,
} from "./shared/contracts.ts";
