/**
 * `skill.update`: changes a space's skill, by someone who manages its space
 * (the rules say): any of its name, when it's for and its instructions, and
 * its files (`files`: the whole set it keeps, so those left out go). In one
 * commit.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { SkillDoc } from "../collections/skill.ts";
import { checked } from "../shared/check.ts";
import { fields, fileDoc, free, invalid, listed, said, SKILL_MD } from "../shared/write.ts";

export const updateAction = defineAction({
  description: "Changes a skill: its name, when it's for, its instructions, its files",
  input: {
    type: "object",
    properties: { skill: { type: "string", minLength: 1 }, ...fields },
    required: ["skill"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const { skill: id, files, instructions } = input;
    const found = await ctx.db.collection<SkillDoc>("skill").findOne({ _id: id });
    if (!found || !found.in) throw invalid("No such skill here: it may have been deleted.");
    const space = found.in;
    const name = input.name?.trim();
    const description = input.description?.trim();
    checked({ name, description, instructions, files });
    if (name && name !== found.name) await free(ctx, space, name, id);
    const gone = files
      ? found.files.filter((f) => !files.some((given) => given.path === f.path))
      : [];
    await ctx.transaction(async (tx) => {
      const set = {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(instructions !== undefined ? { size: instructions.length } : {}),
        ...(files ? { files: listed(files) } : {}),
        updated: new Date().toISOString(),
      };
      const changed = await tx.db.collection("skill").updateOne({ _id: id }, { $set: set });
      if (!changed.matchedCount) throw Object.assign(new Error("gone"), { code: "forbidden" });
      const texts = tx.db.collection("skillFile");
      const write = (path: string, text: string) => {
        const { _id, ...doc } = fileDoc(id, space, path, text);
        return texts.replaceOne({ _id }, doc, { upsert: true });
      };
      if (instructions !== undefined) await write(SKILL_MD, instructions);
      for (const f of files ?? []) await write(f.path, f.text);
      for (const f of gone) await texts.deleteOne({ _id: `${id}:${f.path}` });
    }).catch(said);
    return { skill: id, name: name ?? found.name };
  },
});
