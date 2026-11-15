/**
 * A contact erased (`contact.deleted`): its phone is erased here too, the
 * record of which WhatsApp chats were its, and the templates said to it
 * there: nothing of it stays.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import type { WhatsAppThread } from "../collections/thread.ts";

export const forgetProcessor: ProcessorDef = {
  on: "contact.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const contact = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      const chats = await tx.db.collection<WhatsAppThread>("whatsapp_thread").find({ contact });
      if (chats.length) {
        await tx.db.collection("whatsapp_template").deleteMany({
          thread: { $in: chats.map((c) => c._id) },
        });
      }
      await tx.db.collection("whatsapp_phone").deleteMany({ contact });
      await tx.db.collection("whatsapp_thread").deleteMany({ contact });
    });
  },
};
