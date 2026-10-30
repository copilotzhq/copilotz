/**
 * `computer.view` `{ desk }`: a person has a space's computer open (its
 * panel, its terminal), so a computer that sleeps (a cloud computer) stays
 * awake while they do, up to the app's limit. Their panel calls it every
 * few minutes while it shows. It wakes nothing: a computer that's asleep
 * stays so until there's work for it.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { touch } from "../shared/wake.ts";

export const viewAction = defineAction({
  description: "Says you have a space's computer open, so it stays awake while you do",
  record: false,
  input: {
    type: "object",
    properties: { desk: { type: "string" } },
    required: ["desk"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    // The rules reach only the desks of spaces the person is in.
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) throw Object.assign(new Error("No such computer here"), { code: "invalid" });
    if (desk.online) await touch(ctx, desk.computer, true);
    return null;
  },
});
