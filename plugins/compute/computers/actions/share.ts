/**
 * Puts one of the person's computers in a space they work in (a desk there,
 * its folder named after the space), so its members, and their agents in its
 * conversations, use it; or, already there, changes who answers what agents
 * ask (`answers`: whom the agent works for, or `owner`, only you).
 *
 * Their agents run commands as you, on your machine: share a computer you
 * mean to share.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import { deskIn, mustBeAble } from "../shared/desks.ts";

export const shareAction = defineAction({
  description: "Puts one of your computers in a space, for its members and their agents",
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      in: { type: "string" },
      answers: { enum: ["asker", "owner"] },
    },
    required: ["computer", "in"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    // The rules reach only the person's own computers.
    const computer = await ctx.db.collection<Computer>("computer").findOne({ _id: input.computer });
    if (!computer) throw Object.assign(new Error("No such computer of yours"), { code: "invalid" });
    await mustBeAble(ctx, input.in, "write");
    const desk = await deskIn(ctx, computer, input.in, input.answers);
    if (input.answers && desk.answers !== input.answers) {
      await ctx.as().db.collection("desk").updateOne({ _id: desk._id }, {
        $set: { answers: input.answers },
      });
    }
    return { desk: desk._id };
  },
});
