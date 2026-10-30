/**
 * What a skill people made says: its instructions (`SKILL.md`) and each of
 * its other files, one document each (`<skill>:<path>`), in its space like
 * the skill, so agents read one only when they need it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const skillFileSchema = {
  type: "object",
  properties: {
    /** The skill it belongs to. */
    skill: { type: "string" },
    /** Its space, as the skill's. */
    in: { type: "string" },
    /** Where it is in the skill: `SKILL.md` for its instructions, `templates/plan.md`. */
    path: { type: "string" },
    text: { type: "string" },
  },
  required: ["skill", "path", "text"],
} as const;

export const skillFile = defineCollection({ schema: skillFileSchema, indexes: [["skill"]] });

export type SkillFile = Infer<typeof skillFileSchema> & { _id: string };
