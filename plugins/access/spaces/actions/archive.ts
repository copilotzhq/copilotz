/**
 * `space.archive`: a shared space put away (`archived: true`) or brought
 * back (`false`), by those who manage it. Put away, it's out of the way:
 * front ends list it apart, and agents aren't told of it among the spaces
 * they can read. Nothing in it changes, and it comes back as it was. A
 * Personal space can't be put away.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { Space } from "../collections/space.ts";
import { PERSONAL } from "../shared/personal.ts";
import { may } from "../shared/can.ts";

const refuse = (message: string, code = "forbidden") => Object.assign(new Error(message), { code });

export const archiveAction = defineAction({
  description: "Archives a space you manage, or brings it back",
  input: {
    type: "object",
    properties: { space: { type: "string" }, archived: { type: "boolean" } },
    required: ["space", "archived"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const system = ctx.as();
    const found = await system.db.collection<Space>("space").findOne({ _id: input.space });
    if (!found || !await may(ctx, "manage", input.space)) {
      throw refuse(`You don't manage "${input.space}".`);
    }
    if (found.kind === PERSONAL) throw refuse("A Personal space can't be archived.", "invalid");
    await system.db.collection("space").updateOne(
      { _id: input.space },
      input.archived
        ? { $set: { archived: new Date().toISOString() } }
        : { $unset: { archived: "" } },
    );
    return { space: input.space, archived: input.archived };
  },
});
