/**
 * Writing a space's skill: its fields as the Actions take them, what's
 * refused (a name the app's skills or another of the space's have), and its
 * files as documents (its instructions as `SKILL.md`, then the others).
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { SkillDoc } from "../collections/skill.ts";
import { LIMITS, SKILL_MD } from "./check.ts";
import { appSkills } from "./skills.ts";

/** A skill's fields, as `skill.create` and `skill.update` take them. */
export const fields = {
  name: { type: "string", minLength: 1, maxLength: LIMITS.name },
  description: { type: "string", minLength: 1, maxLength: LIMITS.description },
  instructions: { type: "string", minLength: 1, maxLength: LIMITS.instructions },
  files: {
    type: "array",
    maxItems: LIMITS.files,
    items: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: LIMITS.path },
        text: { type: "string", maxLength: LIMITS.file },
      },
      required: ["path", "text"],
      additionalProperties: false,
    },
  },
} as const;

export const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** Who may change a space's skills, said when someone else tries. */
export const managersOnly = () =>
  Object.assign(new Error("Only those who manage this space make and change its skills."), {
    code: "forbidden",
  });

/** A refusal by the rules (a space the person doesn't manage), said in words. */
export const said = (error: unknown): never => {
  if ((error as { code?: string }).code === "forbidden") throw managersOnly();
  throw error;
};

/** Throws unless `name` is free in `space`: no skill of the app's, nor another of the space's. */
export async function free(ctx: Context, space: string, name: string, self?: string) {
  if (appSkills(ctx)[name]) {
    throw invalid(`"${name}" is the name of one of the app's skills: pick another.`);
  }
  const taken = await ctx.db.collection<SkillDoc>("skill").findOne({ in: space, name });
  if (taken && taken._id !== self) throw invalid(`There's already a skill called "${name}" here.`);
}

/** A skill's file, as a document. */
export const fileDoc = (skill: string, space: string, path: string, text: string) => ({
  _id: `${skill}:${path}`,
  skill,
  in: space,
  path,
  text,
});

/** The other files' paths and lengths, as the skill lists them. */
export const listed = (files: { path: string; text: string }[]) =>
  files.map((f) => ({ path: f.path, size: f.text.length }))
    .sort((a, b) => a.path.localeCompare(b.path));

export { SKILL_MD };
