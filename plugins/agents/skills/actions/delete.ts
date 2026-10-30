/**
 * `skill.delete`: removes a space's skill and its files, by someone who
 * manages its space (the rules say). Conversations that read it keep what
 * they read.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { SkillDoc } from "../collections/skill.ts";
import { invalid, said } from "../shared/write.ts";

export const deleteAction = defineAction({
  description: "Deletes a skill, with its files",
  input: {
    type: "object",
    properties: { skill: { type: "string", minLength: 1 } },
    required: ["skill"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await ctx.db.collection<SkillDoc>("skill").findOne({ _id: input.skill });
    if (!found) throw invalid("No such skill here: it may have been deleted already.");
    await ctx.transaction(async (tx) => {
      const gone = await tx.db.collection("skill").deleteOne({ _id: input.skill });
      if (!gone.deletedCount) throw Object.assign(new Error("kept"), { code: "forbidden" });
      await tx.db.collection("skillFile").deleteMany({ skill: input.skill });
    }).catch(said);
    return { deleted: input.skill, name: found.name };
  },
});
