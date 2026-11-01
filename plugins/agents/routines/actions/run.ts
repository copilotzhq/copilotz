/**
 * `routine.run`: runs a routine now, by its maker or a manager of its
 * space, as time would: as its maker, recorded as a run of its own (with
 * who asked). Its schedule goes on as it was, paused or not.
 */
import { defineAction, personOf } from "../../../../runtime/mod.ts";
import { fire } from "../shared/fire.ts";
import { byId, editable } from "../shared/routines.ts";

export const runAction = defineAction({
  description: "Runs a routine now: its message goes to its agent at once",
  input: byId,
  allow: (actor) => actor.kind === "person",
  run: async (ctx, { routine }) => {
    const found = await editable(ctx, routine);
    const by = personOf(ctx.actor);
    return await fire(ctx, found, {
      id: `${routine}@now:${crypto.randomUUID()}`,
      ...(by ? { by } : {}),
    });
  },
});
