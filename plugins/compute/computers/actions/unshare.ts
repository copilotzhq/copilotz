/**
 * Takes a computer out of a space: its owner can, and so can those who
 * manage the space. What its agents waited on there, and what they were let
 * do, go with it; if it was the space's default, another becomes it. Its
 * folder stays on the machine.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { may, removeDesk } from "../shared/desks.ts";

export const unshareAction = defineAction({
  description: "Takes a computer out of a space",
  input: {
    type: "object",
    properties: { desk: { type: "string" } },
    required: ["desk"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) return { removed: false };
    if (desk.owner !== ctx.actor!.id && !await may(ctx, desk.in, "manage")) {
      throw Object.assign(new Error("Only its owner, or those who manage this space, can."), {
        code: "forbidden",
      });
    }
    await removeDesk(ctx, desk);
    return { removed: true };
  },
});
