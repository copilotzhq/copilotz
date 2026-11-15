/**
 * What's said on WhatsApp goes out: a message in a WhatsApp conversation to
 * that conversation's person or contact, whoever says it (an agent's answer,
 * a question it waits on them for, what trusted code says without a turn,
 * `chat.say`, or the desk's people taking a customer's chat over), as its
 * `whatsapp.message` View shows it: its Markdown as WhatsApp formats it, a
 * long one in several messages split where a reader would pause, then its
 * files. What's said to the whole chat (to nobody in particular, `to: []`)
 * goes too, but not a turn's answer to nobody (handed back elsewhere, or
 * one nobody waits for). Their own words never come back to them; agents'
 * steps (private), what's kept private, and what's said to others there
 * alone (agents to each other, the desk to an agent) stay in the app.
 *
 * After an answer come its additions (chat's `additions` resource, each an
 * `addition:<name>` View here): a carousel of trips, buttons to pay. Each
 * goes once per chat per key. Meta charges each message, so the answer's
 * last text and the first addition go as one when that addition has room
 * for it: the answer is its body (an interactive message's, a picture's
 * caption), its own words only what it says without one. A part Meta refuses (a
 * carousel it won't take) goes as its addition's fallback instead; with
 * none, the addition isn't shown, and that's logged.
 *
 * Only what they may read goes: a message drawing on what they can't see
 * (its `sources`) stays in the app, and a customer is told a turn failed
 * only in a line of their language, never its error. Each part sent is recorded
 * (`whatsapp_sent`, by the message's id), so a retried delivery sends only
 * what's left; each addition shown, in chat's `shown` (`chat.shown`). It
 * reads the conversation's number as the system: its token is what sends.
 *
 * Meta lets a business write freely only in the 24 hours after the phone
 * last wrote; past them, only a template (which this plugin doesn't send).
 * A message Meta refuses for that (131047) fails once, plainly
 * (`window_closed`, the `processor.failed` on the record), and stays in the
 * app; one it takes and then says so of is logged with why (see
 * `undeliveredProcessor`).
 */
import type { Actor, Context, ProcessorDef, Viewer } from "../../../../runtime/mod.ts";
import {
  type Addition,
  type AdditionEntry,
  type AdditionShown,
  isAnswer,
  type Message,
} from "../../../agents/chat/contract.ts";
import { CONTACT } from "../../../access/contacts/contract.ts";
import type { WhatsAppSent } from "../collections/sent.ts";
import type { WhatsAppThread } from "../collections/thread.ts";
import { CUSTOMERS } from "../shared/customers.ts";
import { refused, WINDOW_CLOSED } from "../shared/graph.ts";
import { type Connected, connected, send } from "../shared/number.ts";
import { joined, type WaPart } from "../shared/parts.ts";

/** One WhatsApp message: a part, the ids it's recorded under, and the addition it's of. */
type Out = { ids: string[]; part: WaPart; key?: string };

/** Sends what goes to `to`, once: each of its ids recorded, so a retry skips it. */
type Sending = (out: Out) => Promise<void>;

/** Whom a WhatsApp chat is with, as messages name them, and as they read: none, when it's no one's. */
function addresseeOf(chat: WhatsAppThread | null) {
  const to = chat?.person ?? (chat?.contact ? `${CONTACT}${chat.contact}` : undefined);
  if (!chat || !to) return undefined;
  const reader: Actor = chat.person
    ? { kind: "person", id: chat.person }
    : { kind: "contact", id: chat.contact! };
  const viewer: Viewer = { kind: chat.person ? "person" : "contact", name: to };
  return { to, reader, viewer };
}

/** Sending what goes out after `said` in its chat, once: what went already is `done`. */
async function delivering(
  ctx: Context,
  on: Connected,
  chat: WhatsAppThread,
  said: Message,
  reader: Actor,
): Promise<{ sending: Sending; done: Set<string> }> {
  const done = new Set(
    (await ctx.as().db.collection<WhatsAppSent>("whatsapp_sent").find({ message: said._id }))
      .map((s) => s._id),
  );
  const sending: Sending = async ({ ids, part, key }) => {
    if (ids.every((id) => done.has(id))) return;
    const wamid = await send(ctx, on, chat.phone, part, reader);
    const at = new Date().toISOString();
    for (const id of ids) {
      ctx.record("whatsapp_sent", {
        _id: id,
        message: said._id,
        thread: said.thread,
        ...(key ? { key } : {}),
        wamid,
        at,
      });
      done.add(id);
    }
  };
  return { sending, done };
}

/**
 * Whether a message goes to the phone of the chat it's in (`to`, as messages
 * name them): addressed to them, or said to the whole chat (to nobody in
 * particular) by anyone but a turn; never what they said themselves.
 */
const goesTo = (said: Pick<Message, "from" | "to" | "turn">, to: string): boolean =>
  said.from !== to &&
  ((said.to ?? []).includes(to) || (!said.to?.length && said.turn === undefined));

export const replyProcessor: ProcessorDef = {
  on: "message.created",
  // Anyone's, but never a step or what's kept private: whom it's to is the chat's to say, below.
  where: { "doc.private": { $ne: true } },
  key: (event) => String((event.data.doc as Message | undefined)?.thread),
  run: async (ctx, event) => {
    const said = event.data.doc as Message;
    const chat = await ctx.as().db.collection<WhatsAppThread>("whatsapp_thread")
      .findOne({ _id: said.thread });
    const whom = addresseeOf(chat);
    if (!chat || !whom || !goesTo(said, whom.to)) return;
    const { reader, viewer } = whom;
    // Only what they may read: an answer drawing on what they can't see (its sources) stays here.
    if (!await ctx.as(reader).db.collection("message").findOne({ _id: said._id })) return;
    const on = await connected(ctx, chat.number);
    if (!on) return;
    // A turn that failed tells a customer only that, in their line's language: never its error.
    const own = said.failed && chat.contact
      ? [{ type: "text", text: CUSTOMERS[on.number.language ?? "en"].turn } as WaPart]
      : (await ctx.as(reader).render("whatsapp.message", said, { viewer }) ?? []) as WaPart[];
    const additions = isAnswer(said) ? await additionsAfter(ctx, said, viewer, reader) : [];
    const { sending, done } = await delivering(ctx, on, chat, said, reader);

    const mine: Out[] = own.map((part, i) => ({ ids: [`${said._id}:${i}`], part }));
    // Its last text goes with the first addition, as one message, when that has room.
    const last = mine.at(-1);
    const lead = last?.part.type === "text" && additions[0] ? last : undefined;
    for (const out of lead ? mine.slice(0, -1) : mine) await sending(out);
    for (const [n, addition] of additions.entries()) {
      await show(ctx, said, addition, sending, done, n === 0 ? lead : undefined);
      // Not shown with it (refused, with nothing instead): the answer still goes, before the rest.
      if (n === 0 && lead && !done.has(lead.ids[0])) await sending(lead);
    }
  },
};

/**
 * What Meta took and then couldn't deliver (`whatsapp.undelivered`: a
 * picture it failed to fetch, a carousel): an addition's part goes as that
 * addition's fallback, once (its parts on the ledger), with the answer's
 * text when it went with it. Anything else undelivered is only logged, with
 * why (past the 24 hours since the phone last wrote: only a template goes).
 */
export const undeliveredProcessor: ProcessorDef = {
  on: "whatsapp.undelivered",
  key: (event) => `${event.data.number}:${event.data.to}`,
  run: async (ctx, event) => {
    const { wamid, errors } = event.data as { wamid: string; errors?: unknown[] };
    const system = ctx.as().db;
    const sent = await system.collection<WhatsAppSent>("whatsapp_sent").find({ wamid });
    // An addition's part (`<message>:<key>:<n>`), not one of its fallback's (`…:<key>:f<n>`).
    const failed = sent.find((s) =>
      s.key && s._id.startsWith(`${s.message}:${s.key}:`) &&
      !s._id.startsWith(`${s.message}:${s.key}:f`)
    );
    if (!failed) {
      if (sent.length) {
        console.error(
          `whatsapp: message ${wamid} (${sent[0].message}) wasn't delivered${whyNot(errors)}`,
        );
      }
      return;
    }
    const key = failed.key!;
    const [said, chat] = await Promise.all([
      system.collection<Message>("message").findOne({ _id: failed.message }),
      system.collection<WhatsAppThread>("whatsapp_thread").findOne({ _id: failed.thread }),
    ]);
    const whom = addresseeOf(chat);
    const on = chat ? await connected(ctx, chat.number) : null;
    if (!said || !chat || !whom || !on) return;
    const [addition] = await additionsAfter(ctx, said, whom.viewer, whom.reader, key);
    if (!addition?.fallback?.length) {
      return console.error(`whatsapp: addition "${key}" wasn't delivered, and has no fallback`);
    }
    const { sending } = await delivering(ctx, on, chat, said, whom.reader);
    const outs = addition.fallback.map((part, i): Out => ({
      ids: [`${said._id}:${key}:f${i}`],
      part,
      key,
    }));
    // The answer's text, if it went in the same message: with the fallback (or just before it).
    const lost = sent.find((s) => /^\d+$/.test(s._id.slice(s.message.length + 1)));
    const own = lost
      ? (await ctx.as(whom.reader).render("whatsapp.message", said, { viewer: whom.viewer }) ??
        []) as WaPart[]
      : [];
    const words = lost ? own[Number(lost._id.slice(said._id.length + 1))] : undefined;
    if (words?.type === "text") {
      const together = joined(words.text, outs[0].part, true);
      if (together) outs[0] = { ...outs[0], part: together };
      else outs.unshift({ ids: [`${said._id}:${key}:fa`], part: words, key });
    }
    for (const out of outs) await sending(out);
  },
};

/** Why Meta says it couldn't deliver a message, as a log line ends: its codes and titles. */
function whyNot(errors: unknown[] | undefined): string {
  const said = (errors ?? []) as { code?: number; title?: string; message?: string }[];
  if (said.some((e) => e?.code === WINDOW_CLOSED)) {
    return ": past the 24 hours since the phone last wrote, only a template message reaches it";
  }
  const reasons = said.map((e) => [e?.code, e?.title ?? e?.message].filter(Boolean).join(" "))
    .filter(Boolean);
  return reasons.length ? `: ${reasons.join("; ")}` : "";
}

/**
 * The additions that go after an answer, in order: each entry's View, here,
 * for the answer's agent, read as whom it goes to (`reader`: what they may
 * see, never what whoever's work it was reaches); those already shown in
 * this chat (by key) left out. A View that fails is logged and left out.
 */
async function additionsAfter(
  ctx: Context,
  said: Message,
  viewer: Viewer,
  reader: Actor,
  /** Only the one of this key, shown or not (to send its fallback after all). */
  only?: string,
): Promise<Addition<WaPart>[]> {
  const entries = Object.entries((ctx.resources.additions ?? {}) as Record<string, AdditionEntry>)
    .filter(([, entry]) => entry && (!entry.agents || entry.agents.includes(said.from)))
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  if (!entries.length) return [];
  const system = ctx.as().db;
  const [thread, shown] = await Promise.all([
    system.collection("thread").findOne({ _id: said.thread }),
    system.collection<AdditionShown>("shown").find({ thread: said.thread }),
  ]);
  const seen = new Set(shown.map((s) => s.key));
  const found: Addition<WaPart>[] = [];
  for (const [name] of entries) {
    let made: unknown;
    try {
      made = await ctx.as(reader).render(`addition:${name}`, {
        thread,
        answer: said,
      }, { viewer });
    } catch (error) {
      console.error(`whatsapp: addition "${name}" failed:`, (error as Error).message);
      continue;
    }
    for (
      const addition of (Array.isArray(made) ? made : made ? [made] : []) as Addition<WaPart>[]
    ) {
      if (!/^[\w:.-]{1,120}$/.test(addition?.key ?? "") || !addition.parts?.length) {
        console.error(`whatsapp: addition "${name}" has no key or no parts`);
        continue;
      }
      if (only ? addition.key !== only : seen.has(addition.key)) continue;
      seen.add(addition.key);
      found.push(addition);
    }
  }
  return found;
}

/**
 * Shows one addition after an answer (with that answer's last text, `lead`,
 * in its first part when there's room), then records it. A part Meta refuses
 * sends its fallback instead (the lead joining it, or going first).
 */
async function show(
  ctx: Context,
  said: Message,
  addition: Addition<WaPart>,
  sending: Sending,
  done: Set<string>,
  lead?: Out,
) {
  const { key } = addition;
  const record = (fallback: boolean) =>
    ctx.call("chat.shown", {
      thread: said.thread,
      key,
      after: said._id,
      medium: "whatsapp",
      ...(fallback ? { fallback: true } : {}),
      ...(addition.note ? { note: addition.note.slice(0, 500) } : {}),
    });
  const outs = (parts: WaPart[], tag = "") =>
    parts.map((part, i): Out => ({ ids: [`${said._id}:${key}:${tag}${i}`], part, key }));
  /**
   * The lead in the first part, when that has room (its body, or after a
   * fallback's own words); else the lead first, alone.
   */
  const led = (list: Out[], keep?: boolean): Out[] => {
    if (!lead || done.has(lead.ids[0]) || !list.length) return list;
    const together = lead.part.type === "text"
      ? joined(lead.part.text, list[0].part, keep || list[0].part.type === "text")
      : undefined;
    return together
      ? [{ ids: [...lead.ids, ...list[0].ids], part: together, key }, ...list.slice(1)]
      : [lead, ...list];
  };
  const fallback = outs(addition.fallback ?? [], "f");
  // A retry after its fallback went: the fallback, again (what's sent is skipped).
  if (!fallback.some((out) => done.has(out.ids[0]))) {
    try {
      for (const out of led(outs(addition.parts))) await sending(out);
      return void await record(false);
    } catch (error) {
      if (!refused(error)) throw error;
      console.error(`whatsapp: addition "${key}" couldn't go as it is:`, (error as Error).message);
    }
  }
  if (!fallback.length) return;
  for (const out of led(fallback, true)) await sending(out);
  await record(true);
}
