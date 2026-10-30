/**
 * Skills people make in a space (`in`): its name (what agents call it by),
 * when it's for, and the files it has besides its instructions (each path
 * and size); the instructions and files themselves are `skillFile`
 * documents, read only when wanted. Its managers make, change and delete
 * them (the access plugin's rules); everyone there, and their agents, use
 * them. Its queries, for front ends:
 *
 * - `list`: the skills where the asker is (`{ in }`): the app's, then the
 *   space's, each by name and said the same way (`Shown`);
 * - `read`: one of them (`{ skill, file? }`), with its instructions, or a
 *   file of it;
 * - `files`: the text of each of its other files (`{ skill }`), to change them.
 */
import { defineCollection, type Infer, type ReadContext } from "../../../../runtime/mod.ts";
import { appSkills, type Shown, shownApp, shownSpace } from "../shared/skills.ts";
import { SKILL_MD } from "../shared/check.ts";
import type { SkillFile } from "./skill-file.ts";

const skillSchema = {
  type: "object",
  properties: {
    /** The space it's in. */
    in: { type: "string" },
    /** What agents call it by: `weekly-report`. */
    name: { type: "string" },
    /** When it's for: what agents see beside its name, to decide whether to read it. */
    description: { type: "string" },
    /** How long its instructions are. */
    size: { type: "integer" },
    /** Its other files: each one's path and length. */
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, size: { type: "integer" } },
        required: ["path", "size"],
      },
    },
    /** Who made it: `person:ana`. */
    by: { type: "string" },
    at: { type: "string" },
    updated: { type: "string" },
  },
  required: ["name", "description", "size", "files", "at"],
} as const;

export type SkillDoc = Infer<typeof skillSchema> & { _id: string };

/** A skill's text, the app's or a space's: its instructions, or one of its files. */
async function textOf(ctx: ReadContext, skill: Shown, file: string): Promise<string | undefined> {
  if (skill.source === "app") {
    const declared = appSkills(ctx)[skill.name];
    return file === SKILL_MD ? declared?.instructions : declared?.files?.[file];
  }
  const found = await ctx.db.collection<SkillFile>("skillFile").findOne({
    _id: `${skill._id}:${file}`,
  });
  return found?.text;
}

export const skill = defineCollection({
  schema: skillSchema,
  indexes: [["in"]],
  queries: {
    list: {
      allow: (actor) => actor.kind === "person",
      run: async (skills, params: { in?: string } = {}, ctx) => {
        const made = params.in ? await skills.find({ in: params.in }, { sort: { name: 1 } }) : [];
        const app = Object.entries(appSkills(ctx)).map(([name, s]) => shownApp(name, s))
          .sort((a, b) => a.name.localeCompare(b.name));
        return [...app, ...made.map((doc) => shownSpace(doc as SkillDoc))];
      },
    },
    read: {
      allow: (actor) => actor.kind === "person",
      run: async (skills, params: { skill: string; file?: string }, ctx) => {
        const app = params.skill.startsWith("app:")
          ? appSkills(ctx)[params.skill.slice(4)]
          : undefined;
        const shown = app
          ? shownApp(params.skill.slice(4), app)
          : await skills.findOne({ _id: params.skill }).then((doc) =>
            doc ? shownSpace(doc as SkillDoc) : undefined
          );
        if (!shown) return null;
        const file = params.file ?? SKILL_MD;
        const text = await textOf(ctx, shown, file);
        return text === undefined ? { skill: shown, file, missing: true } : {
          skill: shown,
          file,
          text,
        };
      },
    },
    files: {
      allow: (actor) => actor.kind === "person",
      run: async (skills, params: { skill: string }, ctx) => {
        if (params.skill.startsWith("app:")) {
          const declared = appSkills(ctx)[params.skill.slice(4)];
          return Object.entries(declared?.files ?? {}).map(([path, text]) => ({ path, text }))
            .sort((a, b) => a.path.localeCompare(b.path));
        }
        if (!await skills.findOne({ _id: params.skill })) return [];
        const texts = await ctx.db.collection<SkillFile>("skillFile").find({ skill: params.skill });
        return texts.filter((f) => f.path !== SKILL_MD).map((f) => ({ path: f.path, text: f.text }))
          .sort((a, b) => a.path.localeCompare(b.path));
      },
    },
  },
});
