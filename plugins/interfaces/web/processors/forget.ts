/**
 * A contact erased (`contact.deleted`): if it was a web visitor, its browser's cookie is no one
 * now. Its record says so, ended, for as long as any cookie made before could last (a line's days
 * may be raised after, and a cookie lasts as its line says now, so the most a line may say, from
 * now); it keeps no personal data (its line, its chat's id, its networks' HMACs). Heard or not,
 * it's never taken for a first message that didn't go in (`contact.prune`). What it has open
 * ends too: its browsers' connections, and their way back without a cookie.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import { MOST_DAYS } from "../shared/lines.ts";

export const forgetProcessor: ProcessorDef = {
  on: "contact.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const id = String(event.data._id);
    const system = ctx.as();
    const lasts = new Date(Date.now() + MOST_DAYS * 86_400_000).toISOString();
    await system.db.collection("contact_visitor").updateOne({ _id: id }, {
      $set: { ended: true, spoke: true, expires: lasts },
    });
    await system.disconnect({ kind: "contact", id });
  },
};
