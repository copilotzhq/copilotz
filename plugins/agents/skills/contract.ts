/**
 * The skills plugin's contract: what plugins built on it may import: the
 * shape of a skill an app declares (the `skills` resource), of one a space
 * keeps (`skill`, and its text, `skillFile`), and of a skill as front ends
 * list it. The rest is reached by name: its queries (`skill.list`,
 * `skill.read`), its Actions (`skill.create`, `skill.update`,
 * `skill.delete`) and the tool agents read skills with (`read_skill`).
 */
export type { SkillDoc } from "./collections/skill.ts";
export type { SkillFile } from "./collections/skill-file.ts";
export type { Shown as ShownSkill, Skill } from "./shared/skills.ts";
