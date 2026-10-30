/**
 * What agents say on WhatsApp goes out: a message an agent writes in a
 * WhatsApp conversation, to that conversation's person (its answer, or a
 * question it waits on them for), is sent to their phone as text, its
 * Markdown as WhatsApp formats it, a long one in several messages split
 * where a reader would pause. Their steps (private) and what agents say to
 * each other there stay in the app.
 *
 * Each part sent is recorded (`whatsapp_sent`), so a retried delivery sends
 * only what's left. It reads the conversation's number as the system: its
 * token is what sends.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import type { WhatsAppSent } from "../collections/sent.ts";
import type { WhatsAppThread } from "../collections/thread.ts";
import { connected, send } from "../shared/number.ts";
import { split, toWhatsApp } from "../shared/text.ts";

type Said = { _id: string; thread: string; to?: string[]; text?: string };

export const replyProcessor: ProcessorDef = {
  on: "message.created",
  // An agent's: its answers (written in a turn) and what it sends (after a person's, `hops` ≥ 1).
  where: {
    "doc.private": { $ne: true },
    $or: [{ "doc.turn": { $exists: true } }, { "doc.hops": { $gte: 1 } }],
  },
  key: (event) => String((event.data.doc as Said | undefined)?.thread),
  run: async (ctx, event) => {
    const said = event.data.doc as Said;
    const system = ctx.as().db;
    const chat = await system.collection<WhatsAppThread>("whatsapp_thread")
      .findOne({ _id: said.thread });
    if (!chat || !said.to?.includes(chat.person)) return;
    const text = toWhatsApp(said.text ?? "");
    if (!text) return;
    const on = await connected(ctx, chat.number);
    if (!on) return;
    const done = new Set(
      (await system.collection<WhatsAppSent>("whatsapp_sent").find({ message: said._id }))
        .map((s) => s.part),
    );
    const parts = split(text);
    for (const [part, body] of parts.entries()) {
      if (done.has(part)) continue;
      const wamid = await send(ctx, on, chat.phone, body);
      ctx.record("whatsapp_sent", {
        _id: `${said._id}:${part}`,
        message: said._id,
        part,
        wamid,
        at: new Date().toISOString(),
      });
    }
  },
};
