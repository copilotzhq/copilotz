/**
 * `chat.erase`: a chat, gone with everything chat keeps of it (its messages,
 * files, waits, what's being written, the steps in flight, turns waiting for
 * a quiet moment, the subthreads hanging from it, and its notes), for erasing someone's personal
 * data (LGPD, GDPR). Other plugins erase what they keep of it on `thread.deleted` (the
 * history plugin, its summaries). Ledgers (records: what was `shown` after
 * its answers, what went out to WhatsApp) can't be changed, and the event
 * log keeps what happened: both stay until retention removes them. Trusted
 * code only: it calls this once it decided whose data goes (`contact.forget`).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { quietId } from "../shared/delivery.ts";
import { conversationOf } from "../shared/notes.ts";

export const eraseAction = defineAction({
  description: "Erases a chat and everything in it",
  input: {
    type: "object",
    properties: { thread: { type: "string" } },
    required: ["thread"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const messages = ctx.db.collection<Message>("message");
    // The chat, the subthreads hanging from it all the way down, and its notes: about them too.
    const all = await conversationOf(ctx, input.thread);
    // Who wrote there, and who answers there: their quiet windows (`chat.send`'s `quiet`) end too.
    const [senders, threads] = await Promise.all([
      messages.find({ thread: { $in: all } }),
      ctx.db.collection<Thread>("thread").find({ _id: { $in: all } }),
    ]);
    const from = [...new Set(senders.map((m) => m.from))];
    const agents = [...new Set(threads.flatMap((t) => t.agents ?? []))];
    await ctx.transaction(async (tx) => {
      for (const thread of all) {
        for (const sender of from) {
          for (const agent of agents) tx.unschedule(quietId(thread, sender, agent));
        }
      }
      for (const collection of ["message", "file", "live", "wait", "intent"]) {
        await tx.db.collection(collection).deleteMany({ thread: { $in: all } });
      }
      await tx.db.collection("thread").deleteMany({ _id: { $in: all } });
    });
    return { erased: all.length };
  },
});
