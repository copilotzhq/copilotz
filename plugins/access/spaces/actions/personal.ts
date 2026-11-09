/** `space.personal`: your Personal space (one per person), made the first time it's asked for. */
import { defineAction, forbidden, people, personOf } from "../../../../runtime/mod.ts";
import { PERSONAL } from "../shared/personal.ts";
import { seat } from "../shared/agents.ts";
import { memberKey } from "../shared/reach.ts";
import { keepProfileOf } from "../shared/profile.ts";

export const personalAction = defineAction({
  description: "Your Personal space, where what you make alone lives",
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    // Its person's, even asked by a key of theirs, or their agent.
    const person = personOf(ctx.actor);
    if (!person) throw forbidden("A Personal space is a person's.");
    const id = `personal:${person}`;
    const who = memberKey({ kind: "person", id: person });
    const system = ctx.as();
    if (!await system.db.collection("space").findOne({ _id: id })) {
      await system.transaction(async (tx) => {
        await tx.db.collection("member").insertOne({
          _id: `${id}|${who}`,
          member: who,
          space: id,
          role: "manager",
        });
        // The app's default agents work for you here.
        await tx.db.collection("space").insertOne({
          _id: id,
          name: "Personal",
          kind: PERSONAL,
          owner: person,
          ...await seat(tx, ctx, id),
        });
      });
    }
    // Pages ask this as they open: how they show is kept (from before profiles, too).
    await keepProfileOf(ctx, person);
    return { space: id };
  },
});
