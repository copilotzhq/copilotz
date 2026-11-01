/**
 * Takes a computer out of a space: its owner can, and so can those who
 * manage the space. What its agents waited on there, and what they were let
 * do, go with it; if it was the space's default, another becomes it. Its
 * folder stays on the machine.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { removeDesk } from "../shared/desks.ts";
import { mustOwnOr } from "../../../access/spaces/contract.ts";

export const unshareAction = defineAction({
  description: "Takes a computer out of a space",
  input: {
    type: "object",
    properties: { desk: { type: "string" } },
    required: ["desk"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) return { removed: false };
    await mustOwnOr(
      ctx,
      desk.owner,
      "manage",
      desk.in,
      "Only its owner, or those who manage this space, can.",
    );
    await removeDesk(ctx, desk);
    return { removed: true };
  },
});
