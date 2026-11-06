/**
 * What's being said in a call (the `voice_call` View),
 * read as the line's agent working for its caller: what agents answered
 * them since the call began, in order, each as its `voice.message` View says
 * it; what an agent is writing right now (`live`); and whether the agent
 * ended the call (`end`). The call's socket (routes/relay.ts) observes
 * it, and says what's new as it comes, of the turns the caller's own words
 * started.
 *
 * A caller hears what a web visitor reads, no more: answers, never a step's
 * words before its tools ("Let me check the supplier's sheet…" is the
 * agent's own working, not meant for them), and what's being written only
 * when its turn offers no tools but those called beside an answer (`open`:
 * every step an answer; `end_call` is one). Otherwise
 * `live` names the turn at work with no words: nothing is said while it
 * works. Only what the caller may read is here (the agent working for them
 * reads what both may): an answer drawing on what they can't see isn't.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Live, Message } from "../../../agents/chat/contract.ts";
import type { VoiceCall } from "../collections/call.ts";

/** An agent's words in the call: its message, its turn, and what it was. */
export type Said = {
  _id: string;
  turn?: string;
  replyTo?: string;
  failed?: boolean;
  stopped?: boolean;
  text: string;
  at: string;
};

export type Saying = {
  said: Said[];
  /** The turn writing now, and its words so far when they may be said (else none). */
  live?: { turn: string; text: string; tools?: true };
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
      to,
      private: { $ne: true },
    },
    { sort: { at: -1 }, limit: LATEST },
  ).value ?? [];
  const [writing] = ctx.db.collection<Live>("live").find({ thread: item.thread }).value ?? [];
  const say = (m: Pick<Message, "text" | "from">) => String(ctx.show("voice.message", m) ?? "");
  // Words being written may be said only while they can't turn out to be a step's: its turn
  // offers no tools, and nothing broke (a retry's reason is the provider's).
  const sayable = (l: Live) => l.open === true && !l.calls?.length && !l.retry;
  return {
    said: written.toReversed().map((m) => ({
      _id: m._id,
      ...(m.turn ? { turn: m.turn } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.failed ? { failed: true } : {}),
      ...(m.stopped ? { stopped: true } : {}),
      text: m.text ? say(m) : "",
      at: m.at,
    })),
    ...(writing
      ? {
        live: {
          turn: writing.turn,
          text: sayable(writing) ? say({ text: writing.text, from: writing.agent }) : "",
          // Tools running before any answer (not those called beside one: `open`, nor ending the call).
          ...(!writing.open && writing.calls?.some((c) => c.name !== "end_call")
            ? { tools: true as const }
            : {}),
        },
      }
      : {}),
    ...(call?.end ? { end: call.end } : {}),
  };
};
