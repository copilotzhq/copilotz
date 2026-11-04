/**
 * A contact erased (`contact.deleted`): its phone is erased here too, and the
 * record of which WhatsApp chats were its: nothing of it stays.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";

export const forgetProcessor: ProcessorDef = {
  on: "contact.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const contact = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("whatsapp_phone").deleteMany({ contact });
      await tx.db.collection("whatsapp_thread").deleteMany({ contact });
    });
  },
};
