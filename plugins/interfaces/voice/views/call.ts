/**
 * What's being said in a call (the `voice_call` View, renderer `voice`),
 * read as its caller: what agents wrote for them since the call began, in
 * order (their answers, and a step's words before its tools: "One moment,
 * I'll look"), each as its `message` View here says it; what an agent is
 * writing right now (`live`), said the same way; and whether the agent ended
 * the call (`end`). The call's socket (resources/relay.ts) observes it, and
 * says what's new as it comes, of the turns the caller's own words started.
 * Only what the caller may read is here: an answer drawing on what they
 * can't see isn't.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Live, Message } from "../../../agents/chat/contract.ts";
import type { VoiceCall } from "../collections/call.ts";

/** An agent's words in the call: its message, its turn, and what it was. */
export type Said = {
  _id: string;
  turn?: string;
  replyTo?: string;
  /** A step's words (before its tools), not an answer. */
  step?: boolean;
  failed?: boolean;
  stopped?: boolean;
  text: string;
  at: string;
};

export type Saying = {
  said: Said[];
  live?: { turn: string; text: string };
  end?: { reason: string; after?: string };
};

/** The latest of what's been said that it shows: the socket keeps what it said already. */
const LATEST = 40;

export const callView = (
  item: { _id: string; thread: string; contact: string; since: string },
  ctx: ViewContext<string>,
): Saying => {
  const to = `contact:${item.contact}`;
  const call = ctx.db.collection<VoiceCall>("voice_call").findOne({ _id: item._id }).value;
  const written = ctx.db.collection<Message>("message").find(
    {
      thread: item.thread,
      at: { $gte: item.since },
      from: { $ne: to },
      $or: [{ to }, { private: true, text: { $exists: true } }],
    },
    { sort: { at: -1 }, limit: LATEST },
  ).value ?? [];
  const [writing] = ctx.db.collection<Live>("live").find({ thread: item.thread }).value ?? [];
  const say = (m: Pick<Message, "text" | "from">) => String(ctx.show("message", m) ?? "");
  return {
    said: written.toReversed().map((m) => ({
      _id: m._id,
      ...(m.turn ? { turn: m.turn } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.private ? { step: true } : {}),
      ...(m.failed ? { failed: true } : {}),
      ...(m.stopped ? { stopped: true } : {}),
      text: m.text ? say(m) : "",
      at: m.at,
    })),
    ...(writing
      ? { live: { turn: writing.turn, text: say({ text: writing.text, from: writing.agent }) } }
      : {}),
    ...(call?.end ? { end: call.end } : {}),
  };
};
