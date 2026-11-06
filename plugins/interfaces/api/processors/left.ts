/**
 * Keys end with their place: a key taken out of its space's members (by a
 * manager there) ends; its person out of a space, their keys for it end; out
 * of the org, all of them. However it happened: this follows the membership.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import type { ApiKey } from "../collections/key.ts";
import { endKey } from "../shared/end.ts";

export const leftProcessor: ProcessorDef = {
  on: "member.deleted",
  run: async (ctx, event) => {
    const id = String(event.data._id);
    const at = id.lastIndexOf("|");
    const [space, member] = [id.slice(0, at), id.slice(at + 1)];
    const keys = ctx.as().db.collection<ApiKey>("api_key");
    const ending = member.startsWith("key:")
      ? await keys.find({ _id: member.slice("key:".length) })
      : member.startsWith("person:")
      ? await keys.find(
        space === "*"
          ? { person: member.slice("person:".length) }
          : { person: member.slice("person:".length), in: space },
      )
      : [];
    for (const key of ending) await endKey(ctx, key);
  },
};
