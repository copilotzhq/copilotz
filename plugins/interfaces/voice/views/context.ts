/**
 * What the agent is told on a call (the chat plugin's `voice` context, each
 * turn): when the caller cut its last answer short, what they heard of it,
 * so it doesn't take the rest as said. Nothing otherwise: the contacts
 * plugin already tells it this is a phone call.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message, Thread } from "../../../agents/chat/contract.ts";
import type { VoiceCall } from "../collections/call.ts";

export const contextView = (thread: Thread, ctx: ViewContext<string>) => {
  const [call] = ctx.db.collection<VoiceCall>("voice_call")
    .find({ thread: thread._id }, { sort: { at: -1 }, limit: 1 }).value ?? [];
  if (!call?.cut) return undefined;
  // Only about its latest answer: once it answers again, that's what was heard.
  const [latest] = ctx.db.collection<Message>("message").find(
    { thread: thread._id, turn: { $exists: true }, private: { $ne: true } },
    { sort: { at: -1 }, limit: 1 },
  ).value ?? [];
  if (latest?._id !== call.cut.message) return undefined;
  const heard = call.cut.heard.trim();
  return heard
    ? `The caller cut your last answer short: they heard only "${heard}".`
    : "The caller cut your last answer short, before they heard any of it.";
};
