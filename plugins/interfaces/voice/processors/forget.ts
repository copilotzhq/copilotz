/**
 * What's kept of a caller goes with them:
 *
 * - **A contact erased** (`contact.deleted`): its number goes from the
 *   line's callers and from the records of its calls, with what it heard of
 *   a cut answer. A block on the number stays (it's kept by a hash).
 * - **A chat erased** (`thread.deleted`, `chat.erase`; `contact.forget`
 *   with its chats): its calls' records no longer name it, nor keep what
 *   the caller heard there, and no caller's next call goes on in it.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";

export const forgetProcessor: ProcessorDef = {
  on: "contact.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const contact = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("voice_phone").deleteMany({ contact });
      await tx.db.collection("voice_call").updateMany({ contact }, {
        $set: { erased: true },
        $unset: { from: "", cut: "" },
      });
    });
  },
};

export const erasedProcessor: ProcessorDef = {
  on: "thread.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const thread = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("voice_call").updateMany({ thread }, {
        $unset: { thread: "", cut: "" },
      });
      await tx.db.collection("voice_phone").updateMany({ thread }, { $unset: { thread: "" } });
    });
  },
};
