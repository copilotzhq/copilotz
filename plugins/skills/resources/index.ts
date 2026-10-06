/**
 * Exposes Skill Resource definitions and parsers.
 *
 * @module
 */

export {
  createBundledSkill,
  createInlineSkill,
  normalizeSkillPath,
  parseSkillMarkdown,
  readSkillFileText,
  skillFileMediaType,
  validateSkillManifest,
} from "./skill/index.ts";
export type {
  DefineInlineSkillInput,
  DefineSkillInput,
  InlineSkillFile,
  ParsedSkillMarkdown,
  ParseSkillMarkdownOptions,
  SkillFileLoader,
} from "./skill/index.ts";
