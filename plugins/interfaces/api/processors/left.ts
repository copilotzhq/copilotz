/**
 * A person is out of a space: their keys for it end. Out of the org, all of
 * them. However they left: this follows the membership.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";

export const leftProcessor: ProcessorDef = {
  on: "member.deleted",
  run: async (ctx, event) => {
    const id = String(event.data._id);
    const at = id.lastIndexOf("|");
    const [space, member] = [id.slice(0, at), id.slice(at + 1)];
    if (!member.startsWith("person:")) return;
    const person = member.slice("person:".length);
    await ctx.as().db.collection("api_key").deleteMany(
      space === "*" ? { person } : { person, in: space },
    );
  },
};
