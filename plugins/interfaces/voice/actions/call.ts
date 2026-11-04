/**
 * A call, as its socket goes (see resources/relay.ts, which calls these as
 * the system; nobody outside may):
 *
 * - `voice.admit`: the socket's ticket, used: the call, if the ticket is
 *   one Twilio was given for it, unused and under a minute old. It works
 *   once: the call then holds its place among the line's calls at once for
 *   the line's longest call.
 * - `voice.start`: the call is on: its caller is a contact (the one this
 *   number was before, by line and number; a hidden number is a new one
 *   each call), in a chat in the line's space, answered by the line's agent:
 *   the one they were in, unless it's been quiet for the line's `gap`. The
 *   greeting Twilio says is written there too, as the agent's (`chat.say`),
 *   so the agent knows it was said and doesn't greet them again.
 * - `voice.heard`: the caller cut what an agent said short (a message), and
 *   heard this much of it (the agent is told, the next turn: views/context.ts).
 * - `voice.over`: the call ended, and why.
 *
 * None is recorded: they're the call's own bookkeeping, and the ticket
 * stays out of the log.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import type { VoicePhone } from "../collections/phone.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import { lineOf } from "../shared/settings.ts";
import { sha256, SLACK_MS } from "./hook.ts";

/** What the socket knows of its call once admitted. */
export type Admitted = Pick<VoiceCall, "_id" | "line" | "from" | "to">;

/**
 * What `voice.start` gives the socket: whom it's talking with, where, since
 * when, and the greeting's message (Twilio says it: the socket doesn't).
 */
export type Started = { contact: string; thread: string; since: string; greeting?: string };

/** Whether two strings are the same, in time that doesn't say where they differ. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

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
      $set: { until: new Date(now + line.limits.call * 1000 + SLACK_MS).toISOString() },
      $unset: { ticket: "" },
    });
    if (!modifiedCount) return null;
    return { _id: id, line: found.line, ...(found.from ? { from: found.from } : {}), to: found.to };
  },
});

/** A number Twilio gives for a caller: E.164. Anything else (hidden, a client) is nobody's. */
const NUMBER = /^\+[1-9]\d{6,14}$/;

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
    if (call.contact && call.thread) {
      return {
        contact: call.contact,
        thread: call.thread,
        since: call.started!,
        ...greeting(call),
      };
    }
    const system = ctx.as();
    // Its space, when the app declares that too: made, or kept, first.
    await system.call("space.keep", { id: line.in });
    const phones = system.db.collection<VoicePhone>("voice_phone");
    const number = call.from && NUMBER.test(call.from) ? call.from : undefined;
    const key = `${line.name}:${number}`;
    const known = number ? await phones.findOne({ _id: key }) : null;
    // From the call, so asking again makes the same one.
    const { contact } = await system.call<{ contact: string }>("contact.start", {
      id: known?.contact ?? `c-${(await sha256(`voice:${call._id}`)).slice(0, 24)}`,
      in: line.in,
      via: "voice",
    });
    // The chat they were in, read as them: one they no longer reach (taken out of it) is over.
    const current = known?.thread
      ? await ctx.as({ kind: "contact", id: contact }).db.collection<{ at: string }>("thread")
        .findOne({ _id: known.thread })
      : null;
    const ongoing = current && Date.now() - Date.parse(current.at) < line.gap * 3_600_000;
    const thread = ongoing
      ? known!.thread!
      : await chatFor(ctx, line.in, line.agent, contact, call);
    const now = new Date().toISOString();
    await system.transaction(async (tx) => {
      if (number) {
        await tx.db.collection("voice_phone").replaceOne(
          { _id: key },
          { line: line.name, phone: number, contact, thread, at: now },
          { upsert: true },
        );
      }
      await tx.db.collection("voice_call").updateOne({ _id: call._id }, {
        $set: {
          state: "live",
          contact,
          thread,
          started: now,
          ...(input.session ? { session: input.session } : {}),
        },
      });
    });
    // What Twilio says first, in the chat: the agent doesn't say it again.
    const text = line.texts.greeting;
    const chat = text
      ? await system.db.collection<Thread>("thread").findOne({ _id: thread })
      : null;
    const from = line.agent && chat?.agents?.includes(line.agent) ? line.agent : chat?.agents?.[0];
    if (text && from) {
      await system.call("chat.say", {
        id: `voice:${call._id}`,
        thread,
        from,
        text,
        to: [`contact:${contact}`],
      });
    }
    return {
      contact,
      thread,
      since: now,
      ...(text && from ? greeting({ _id: call._id, thread }) : {}),
    };
  },
});

/** The greeting's message in a call's chat (`chat.say`'s id for it). */
const greeting = (call: Pick<VoiceCall, "_id" | "thread">) =>
  call.thread ? { greeting: `${call.thread}:say:voice:${call._id}` } : {};

/**
 * A new chat for a caller, in the line's space, opened by its agent (while it
 * still answers there; else by whoever answers new chats there), with an id
 * from the call.
 */
async function chatFor(
  ctx: Context,
  space: string,
  agent: string | undefined,
  contact: string,
  call: VoiceCall,
) {
  const thread = `voice-${(await sha256(`voice:${call._id}`)).slice(0, 32)}`;
  const open = (who?: string) =>
    ctx.as().call("contact.chat", { contact, in: space, thread, ...(who ? { agent: who } : {}) });
  try {
    await open(agent);
  } catch (error) {
    if ((error as { code?: string }).code !== "not_here") throw error;
    await open();
  }
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
      $unset: { ticket: "" },
    });
  },
});
