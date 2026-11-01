/**
 * `cloud.org` `{}`: the org's cloud computers, newest first, for its owners
 * and admins (and platform staff), after asking the org who's calling
 * (`org.me`); anyone else's own, as `cloudComputer.mine` gives them. Says
 * whose they are (`all`). Only reads, so it isn't recorded.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { CloudComputer } from "../contract.ts";
import { runs, standingOf } from "../shared/people.ts";

export const orgAction = defineAction({
  description: "The org's cloud computers, for its owners and admins; your own for others",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    const all = runs(await standingOf(ctx));
    // Everyone's, read as the system, once the org says they run it; else theirs, as the guard keeps.
    const computers = await (all ? ctx.as() : ctx).db.collection<CloudComputer>("cloudComputer")
      .find({}, { sort: { at: -1 } });
    return { computers, all };
  },
});
