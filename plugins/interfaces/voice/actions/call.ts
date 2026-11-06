/**
 * A call, as its socket goes (see resources/relay.ts, which calls these as
 * the system; nobody outside may):
 *
 * - `voice.admit`: the socket's ticket, used: the call, if the ticket is
 *   one Twilio was given for it, unused and under a minute old. It works
 *   once: the call then holds its place among the line's calls at once
 *   until its hard end (the line's longest call, the goodbye's wait and
 *   closing: `lastsMs`), which the socket never lets it outlast.
 * - `voice.start`: the call is on: its caller is a contact, in a chat in the
 *   line's space, answered by the line's agent (a line whose agent no longer
 *   answers there fails the call: no other agent takes it). Who the caller
 *   is goes by their number only when Twilio verified it, or the line
 *   trusts numbers (`trustCallerId`): then it's the contact that number was
 *   before, in the chat they were in, unless it's been quiet for the line's
 *   `gap`, or another call is on in it (checked in the very write that puts
 *   this call live, so two at once can't both join). Any other call, a hidden number's
 *   too, is a new contact in a new chat. The greeting Twilio says is
 *   written there too, as the agent's (`chat.say`), so the agent knows it
 *   was said and doesn't greet them again.
 * - `voice.heard`: the caller cut what an agent said short (a message), and
 *   heard this much of it (the agent is told, the next turn: views/context.ts).
 * - `voice.over`: the call ended, and why. What the caller heard of a cut
 *   answer goes with it.
 *
 * None is recorded: they're the call's own bookkeeping, and the ticket
 * stays out of the log.
 */
import { type Context, defineAction, type TransactionScope } from "../../../../runtime/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import type { VoicePhone } from "../collections/phone.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import { lastsMs, type Line, lineOf } from "../shared/settings.ts";
import { numberOf } from "../shared/caller.ts";
import { sha256 } from "./ring.ts";

/** What the socket knows of its call once admitted. */
export type Admitted = Pick<VoiceCall, "_id" | "line" | "from" | "to">;

/**
 * What `voice.start` gives the socket: whom it's talking with, where, since
 * when, the agent answering, and the greeting's message (Twilio says it:
 * the socket doesn't).
 */
export type Started = {
  contact: string;
  thread: string;
  since: string;
  agent: string;
  greeting?: string;
};

/** Whether two strings are the same, in time that doesn't say where they differ. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/** A margin on a call's place, past its hard end: clocks and commits aren't instant. */
const MARGIN_MS = 5_000;

const calls = (ctx: Context) => ctx.as().db.collection<VoiceCall>("voice_call");

export const admitAction = defineAction({
  description: "Uses a call's socket ticket, once",
  input: {
    type: "object",
    properties: {
      line: { type: "string" },
      ticket: { type: "string", maxLength: 200 },
    },
    required: ["line", "ticket"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input): Promise<Admitted | null> => {
    const line = lineOf(ctx, input.line);
    const [id, secret] = input.ticket.split(".");
    if (!line || !id || !secret) return null;
    const found = await calls(ctx).findOne({ _id: id });
    const now = Date.now();
    if (
      !found?.ticket || found.state !== "ringing" || found.line !== line.name ||
      Date.parse(found.until) <= now || !same(found.ticket, await sha256(secret))
    ) return null;
    // Used once: only the first of two at once finds its ticket still there.
    const { modifiedCount } = await calls(ctx).updateOne({ _id: id, ticket: found.ticket }, {
      $set: { until: new Date(now + lastsMs(line) + MARGIN_MS).toISOString() },
      $unset: { ticket: "" },
    });
    if (!modifiedCount) return null;
    return { _id: id, line: found.line, ...(found.from ? { from: found.from } : {}), to: found.to };
  },
});

export const startAction = defineAction({
  description: "A call is on: its caller's contact and chat",
  input: {
    type: "object",
    properties: {
      call: { type: "string" },
      session: { type: "string", maxLength: 100 },
    },
    required: ["call"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input): Promise<Started> => {
    const call = await calls(ctx).findOne({ _id: input.call });
    const line = call ? lineOf(ctx, call.line) : undefined;
    if (!call || !line || call.state === "over") {
      throw Object.assign(new Error("No such call going on"), { code: "not_found" });
    }
    const system = ctx.as();
    if (call.contact && call.thread) {
      return {
        contact: call.contact,
        thread: call.thread,
        since: call.started!,
        ...await whom(ctx, line, call.thread),
        ...greeting(call),
      };
    }
    // Its space, when the app declares that too: made, or kept, first.
    await system.call("space.keep", { id: line.in });
    // Who they are goes by their number only when it's proof enough of it.
    const number = numberOf(call.from);
    const trusted = number && (call.verified || line.trustCallerId) ? number : undefined;
    const phones = system.db.collection<VoicePhone>("voice_phone");
    const key = `${line.name}:${trusted}`;
    const known = trusted ? await phones.findOne({ _id: key }) : null;
    // From the call, so asking again makes the same one.
    const { contact } = await system.call<{ contact: string }>("contact.start", {
      id: known?.contact ?? `c-${(await sha256(`voice:${call._id}`)).slice(0, 24)}`,
      in: line.in,
      via: "voice",
    });
    // The chat they were in, if it goes on; else a new one. Another call on in it (two at once
    // from one number) is checked again with the write that puts this one live: nobody joins.
    let thread = await chatOf(ctx, line, contact, known?.thread);
    const now = new Date().toISOString();
    const live = async (tx: TransactionScope, chat: string, joining: boolean) => {
      const calls = tx.db.collection<VoiceCall>("voice_call");
      if (joining && (await calls.find({ thread: chat, state: "live" })).length) return false;
      if (trusted) {
        await tx.db.collection("voice_phone").replaceOne(
          { _id: key },
          { line: line.name, phone: trusted, contact, thread: chat, at: now },
          { upsert: true },
        );
      }
      await calls.updateOne({ _id: call._id }, {
        $set: {
          state: "live",
          contact,
          thread: chat,
          started: now,
          ...(input.session ? { session: input.session } : {}),
        },
      });
      return true;
    };
    if (!thread || !await system.transaction((tx) => live(tx, thread!, true))) {
      thread = await chatFor(ctx, line, contact, call);
      await system.transaction((tx) => live(tx, thread!, false));
    }
    const { agent } = await whom(ctx, line, thread);
    // What Twilio says first, in the chat: the agent doesn't say it again.
    const text = line.texts.greeting;
    if (text) {
      await system.call("chat.say", {
        id: `voice:${call._id}`,
        thread,
        from: agent,
        text,
        to: [`contact:${contact}`],
      });
    }
    return {
      contact,
      thread,
      since: now,
      agent,
      ...(text ? greeting({ _id: call._id, thread }) : {}),
    };
  },
});

/** The greeting's message in a call's chat (`chat.say`'s id for it). */
const greeting = (call: Pick<VoiceCall, "_id" | "thread">) =>
  call.thread ? { greeting: `${call.thread}:say:voice:${call._id}` } : {};

/** The agent answering in a call's chat: the line's, else the chat's own. */
async function whom(ctx: Context, line: Line, thread: string): Promise<{ agent: string }> {
  if (line.agent) return { agent: line.agent };
  const chat = await ctx.as().db.collection<Thread>("thread").findOne({ _id: thread });
  const agent = chat?.agents?.[0];
  if (!agent) throw Object.assign(new Error("Nobody answers this chat"), { code: "not_here" });
  return { agent };
}

/**
 * The chat a known caller was in, read as them, when it goes on: one they
 * no longer reach (taken out of it), or quiet for the line's gap, doesn't.
 */
async function chatOf(
  ctx: Context,
  line: Line,
  contact: string,
  thread: string | undefined,
): Promise<string | undefined> {
  if (!thread) return undefined;
  const current = await ctx.as({ kind: "contact", id: contact }).db
    .collection<{ at: string }>("thread").findOne({ _id: thread });
  return current && Date.now() - Date.parse(current.at) < line.gap * 3_600_000 ? thread : undefined;
}

/**
 * A new chat for a caller, in the line's space, opened by the line's agent
 * (else by whoever answers new chats there), with an id from the call. When
 * the line's agent doesn't answer in the space, the call fails: no other
 * agent takes it.
 */
async function chatFor(ctx: Context, line: Line, contact: string, call: VoiceCall) {
  const thread = `voice-${(await sha256(`voice:${call._id}`)).slice(0, 32)}`;
  await ctx.as().call("contact.chat", {
    contact,
    in: line.in,
    thread,
    ...(line.agent ? { agent: line.agent } : {}),
  });
  return thread;
}

export const heardAction = defineAction({
  description: "A caller cut an answer short: what they heard of it",
  input: {
    type: "object",
    properties: {
      call: { type: "string" },
      message: { type: "string" },
      heard: { type: "string" },
    },
    required: ["call", "message", "heard"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    await calls(ctx).updateOne({ _id: input.call, state: "live" }, {
      $set: { cut: { message: input.message, heard: input.heard.slice(0, 1_000) } },
    });
  },
});

export const overAction = defineAction({
  description: "A call ended, and why",
  input: {
    type: "object",
    properties: {
      call: { type: "string" },
      reason: { type: "string", maxLength: 20 },
    },
    required: ["call", "reason"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    const found = await calls(ctx).findOne({ _id: input.call });
    if (!found || found.state === "over") return;
    const now = new Date();
    await calls(ctx).updateOne({ _id: input.call }, {
      $set: {
        state: "over",
        over: now.toISOString(),
        reason: input.reason,
        ...(found.started
          ? { seconds: Math.round((now.getTime() - Date.parse(found.started)) / 1000) }
          : {}),
      },
      // What they heard of a cut answer was for the call's own turns.
      $unset: { ticket: "", cut: "" },
    });
  },
});
