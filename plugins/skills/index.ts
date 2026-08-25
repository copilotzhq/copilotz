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
export { createSkillsPlugin } from "./plugin.ts";
export type { CreateSkillsPluginOptions } from "./plugin.ts";
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
} from "./internal/contracts.ts";
