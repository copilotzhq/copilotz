/**
 * `skill.create`: a skill in a space, made by someone who manages it (the
 * rules say): its name, when it's for, its instructions and any files, all
 * in one commit.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { checked } from "../shared/check.ts";
import { fields, fileDoc, free, listed, said, SKILL_MD } from "../shared/write.ts";

export const createAction = defineAction({
  description: "Makes a skill in a space: know-how its agents read when a task needs it",
  input: {
    type: "object",
    properties: { in: { type: "string", minLength: 1 }, ...fields },
    required: ["in", "name", "description", "instructions"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const files = input.files ?? [];
    const name = input.name.trim();
    checked({ ...input, name, files });
    await free(ctx, input.in, name);
    const skill = crypto.randomUUID();
    const at = new Date().toISOString();
    await ctx.transaction(async (tx) => {
      await tx.db.collection("skill").insertOne({
        _id: skill,
        in: input.in,
        name,
        description: input.description.trim(),
        size: input.instructions.length,
        files: listed(files),
        ...(ctx.actor ? { by: `${ctx.actor.kind}:${ctx.actor.id}` } : {}),
        at,
      });
      await tx.db.collection("skillFile").insertMany([
        fileDoc(skill, input.in, SKILL_MD, input.instructions),
        ...files.map((f) => fileDoc(skill, input.in, f.path, f.text)),
      ]);
    }).catch(said);
    return { skill, name };
  },
});
