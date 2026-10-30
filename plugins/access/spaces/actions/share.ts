/**
 * `share`: shows a labelled document to everyone in its space, by clearing
 * its sources. Only someone who reaches all of them, and may write where it
 * is, can: they choose to show what came from there.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { reachOf } from "../shared/reach.ts";
import type { Shared } from "../shared/rules.ts";

const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

export const shareAction = defineAction({
  description: "Shows a labelled document to everyone where it is",
  input: {
    type: "object",
    properties: { collection: { type: "string" }, id: { type: "string" } },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const field = ((ctx.resources.shared ?? {}) as Shared)[input.collection]?.field ?? "in";
    const system = ctx.as();
    const doc = await system.db.collection(input.collection).findOne({ _id: input.id });
    if (!doc) throw forbidden(`No ${input.collection} "${input.id}".`);
    const reach = await reachOf(ctx.actor!, system);
    const sources = (doc.sources ?? []) as string[];
    const hidden = sources.filter((space) => !reach.get(space)?.can.has("read"));
    if (hidden.length || !reach.get(String(doc[field]))?.can.has("write")) {
      throw forbidden(
        hidden.length
          ? `You can't see ${hidden.join(", ")}, so you can't show what came from there.`
          : `You can't write in ${doc[field]}.`,
      );
    }
    await system.db.collection(input.collection).updateOne({ _id: input.id }, {
      $unset: { sources: true },
    });
    return { shared: sources };
  },
});
