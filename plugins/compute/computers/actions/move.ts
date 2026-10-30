/**
 * Moves one of the person's computers from one space to another: its desk
 * there goes (and what agents waited on or were let do with it), and it has
 * one in the other, its folder named after that space, answering as it
 * did. Only its owner moves it, into a space they may work in. Its old
 * folder stays on the machine.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { deskIn, mustBeAble, removeDesk } from "../shared/desks.ts";

export const moveAction = defineAction({
  description: "Moves one of your computers to another space",
  input: {
    type: "object",
    properties: { desk: { type: "string" }, to: { type: "string" } },
    required: ["desk", "to"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    // The rules reach only the person's own computers.
    const computer = desk &&
      await ctx.db.collection<Computer>("computer").findOne({ _id: desk.computer });
    if (!desk || !computer) {
      throw Object.assign(new Error("No such computer of yours here"), { code: "invalid" });
    }
    if (desk.in === input.to) return { desk: desk._id };
    await mustBeAble(ctx, input.to, "write");
    const moved = await deskIn(ctx, computer, input.to, desk.answers);
    await removeDesk(ctx, desk);
    return { desk: moved._id };
  },
});
