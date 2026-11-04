/**
 * A contact erased (`contact.deleted`): its number is erased here too, from
 * the line's callers and from the records of its calls.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";

export const forgetProcessor: ProcessorDef = {
  on: "contact.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const contact = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("voice_phone").deleteMany({ contact });
      await tx.db.collection("voice_call").updateMany({ contact }, { $unset: { from: "" } });
    });
  },
};
