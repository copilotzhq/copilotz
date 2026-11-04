/**
 * What agents say on WhatsApp goes out: a message an agent writes in a
 * WhatsApp conversation, to that conversation's person or contact (its
 * answer, a question it waits on them for, or what it says without a turn:
 * `chat.say`), as its `message` View in the `whatsapp` medium shows it: its
 * Markdown as WhatsApp formats it, a long one in several messages split
 * where a reader would pause. Their steps (private) and what agents say to
 * each other there stay in the app.
 *
 * After an answer come its additions (chat's `additions` resource, each an
 * `addition:<name>` View here): a carousel of trips, buttons to pay. Each
 * goes once per chat per key. Meta charges each message, so the answer's
 * last text and the first addition go as one when that addition has room
 * for it (an interactive message carries body text). A part Meta refuses (a
 * carousel it won't take) goes as its addition's fallback instead; with
 * none, the addition isn't shown, and that's logged.
 *
 * Only what they may read goes: a message drawing on what they can't see
 * (its `sources`) stays in the app. Each part sent is recorded
 * (`whatsapp_sent`), so a retried delivery sends only what's left; each
 * addition shown, in chat's `shown` (`chat.shown`). It reads the
 * conversation's number as the system: its token is what sends.
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
import { refused } from "../shared/graph.ts";
import { connected, send } from "../shared/number.ts";
import { joined, type WaPart } from "../shared/parts.ts";

/** One WhatsApp message: a part, the ids it's recorded under, and the addition it's of. */
type Out = { ids: string[]; part: WaPart; key?: string };

/** Sends what goes to `to`, once: each of its ids recorded, so a retry skips it. */
type Sending = (out: Out) => Promise<void>;

export const replyProcessor: ProcessorDef = {
  on: "message.created",
  // An agent's: its answers (written in a turn) and what it sends (after a person's, `hops` ≥ 1).
  where: {
    "doc.private": { $ne: true },
    $or: [{ "doc.turn": { $exists: true } }, { "doc.hops": { $gte: 1 } }],
  },
  key: (event) => String((event.data.doc as Message | undefined)?.thread),
  run: async (ctx, event) => {
    const said = event.data.doc as Message;
    const system = ctx.as().db;
    const chat = await system.collection<WhatsAppThread>("whatsapp_thread")
      .findOne({ _id: said.thread });
    // Whom it's with: a person by id, a contact as messages name them.
    const to = chat?.person ?? (chat?.contact ? `${CONTACT}${chat.contact}` : undefined);
    if (!chat || !to || !said.to?.includes(to)) return;
    // Only what they may read: an answer drawing on what they can't see (its sources) stays here.
    const reader: Actor = chat.person
      ? { kind: "person", id: chat.person }
      : { kind: "contact", id: chat.contact! };
    if (!await ctx.as(reader).db.collection("message").findOne({ _id: said._id })) return;
    const on = await connected(ctx, chat.number);
    if (!on) return;
    const viewer: Viewer = { kind: chat.person ? "person" : "contact", name: to };
    const own = (await ctx.render("whatsapp", "message", said, { viewer }) ?? []) as WaPart[];
    const additions = isAnswer(said) ? await additionsAfter(ctx, said, viewer) : [];
    const done = new Set(
      (await system.collection<WhatsAppSent>("whatsapp_sent").find({ message: said._id }))
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
 * The additions that go after an answer, in order: each entry's View, here,
 * for the answer's agent; those already shown in this chat (by key) left out.
 * A View that fails is logged and left out.
 */
async function additionsAfter(
  ctx: Context,
  said: Message,
  viewer: Viewer,
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
      made = await ctx.render("whatsapp", `addition:${name}`, { thread, answer: said }, {
        viewer,
      });
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
      if (seen.has(addition.key)) continue;
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
  /** The lead in the first part, when that has room; else the lead first, alone. */
  const led = (list: Out[]): Out[] => {
    if (!lead || done.has(lead.ids[0]) || !list.length) return list;
    const together = lead.part.type === "text" ? joined(lead.part.text, list[0].part) : undefined;
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
  for (const out of led(fallback)) await sending(out);
  await record(true);
}
