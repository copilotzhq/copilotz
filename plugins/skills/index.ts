/** Declarative Skills with lazy root loading across runtimes. @module */
export { defineSkill } from "./authoring/define-skill/index.ts";
export type {
  DefinedSkill,
  DefineSkillInput,
} from "./authoring/define-skill/index.ts";
export {
  normalizeSkillPath,
  parseSkillMarkdown,
  readSkillFileText,
  skillFileMediaType,
  validateSkillManifest,
} from "./resources/index.ts";
export type {
  InlineSkillFile,
  ParsedSkillMarkdown,
  ParseSkillMarkdownOptions,
  SkillFileLoader,
} from "./resources/index.ts";
export { SKILL_TOOL_IDS } from "./authoring/action-resources/index.ts";
export type { SkillToolId } from "./authoring/action-resources/index.ts";
export type {
  Skill,
  SkillFile,
  SkillFileBody,
  SkillFileDescriptor,
  SkillIndexEntry,
  SkillManifest,
  SkillReadOptions,
} from "./shared/contracts.ts";
