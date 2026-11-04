/**
 * "Typing…" while an agent works: each step it takes in a WhatsApp chat
 * (its tool calls, private) shows it again on the message it's answering,
 * once WhatsApp may have hidden it (after 20 seconds), for up to five
 * minutes after that message came. Nothing is sent to say "please wait".
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import type { WhatsAppTyping } from "../collections/typing.ts";
import { markRead } from "../shared/graph.ts";
import { connected } from "../shared/number.ts";

const AGAIN = 20_000;
const LONGEST = 5 * 60_000;

export const typingProcessor: ProcessorDef = {
  on: "message.created",
  // An agent's step: it's at work still.
  where: { "doc.private": true, "doc.turn": { $exists: true } },
  key: (event) => String((event.data.doc as { thread?: string } | undefined)?.thread),
  run: async (ctx, event) => {
    const thread = String((event.data.doc as { thread: string }).thread);
    const typing = ctx.as().db.collection<WhatsAppTyping>("whatsapp_typing");
    const answering = await typing.findOne({ _id: thread });
    const now = Date.now();
    if (!answering || now - Date.parse(answering.at) > LONGEST) return;
    if (now - Date.parse(answering.shown) < AGAIN) return;
    const on = await connected(ctx, answering.number);
    if (!on) return;
    await markRead(on.graph, answering.wamid, true).catch(() => {});
    await typing.updateOne({ _id: thread }, { $set: { shown: new Date(now).toISOString() } });
  },
};
