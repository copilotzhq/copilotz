/**
 * `space.rename`: a space's new name, from those who manage it. A Personal
 * space keeps its name: it's what everyone's own is called.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { Space } from "../collections/space.ts";
import { PERSONAL } from "../shared/personal.ts";
import { may } from "../shared/can.ts";

const refuse = (message: string, code = "forbidden") => Object.assign(new Error(message), { code });

export const renameAction = defineAction({
  description: "Renames a space you manage",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 60 },
    },
    required: ["space", "name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const name = input.name.trim();
    if (!name) throw refuse("A space needs a name.", "invalid");
    const system = ctx.as();
    const found = await system.db.collection<Space>("space").findOne({ _id: input.space });
    if (!found || !await may(ctx, "manage", input.space)) {
      throw refuse(`You don't manage "${input.space}".`);
    }
    if (found.kind === PERSONAL) throw refuse("A Personal space keeps its name.", "invalid");
    await system.db.collection("space").updateOne({ _id: input.space }, { $set: { name } });
    return { space: input.space, name };
  },
});
