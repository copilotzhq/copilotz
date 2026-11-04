/**
 * What someone sent a connected number (`whatsapp.received`), handled in
 * order for each phone:
 *
 * - **A stranger** (a phone not linked to anyone) is told how to link it,
 *   once a day, and nothing else. A six-digit code they send is tried:
 *   one the app gave a person, unexpired, links the phone to them (five
 *   wrong ones in an hour, and it stops listening to codes for a while).
 * - **A customer**, on an open number (a customer line), is a stranger too,
 *   who is answered: a contact (made from their first message), writing in
 *   a chat of their own in the number's space, to its agent. A chat quiet
 *   for the number's `gap` (12 hours) is over: their next message starts a
 *   new one. What they write always goes to the agent (commands are linked
 *   people's), except a code that links their phone. More than the number's
 *   `rate` a minute (20) goes unanswered; a phone its people blocked, or took
 *   out of its chat (until the gap passes), is let go without a word; what
 *   they're told is in the number's `language`.
 * - **Someone linked**, still in the number's space: their message is
 *   marked read (with "typing…") and becomes `chat.send`, as them, in
 *   their WhatsApp conversation, in the space they chose (their Personal
 *   space unless they said otherwise). Photos, documents, video and voice
 *   notes come as its files (chat transcribes audio as it's sent). A reply
 *   quoting an agent's message, or one sent while an agent waits on their
 *   answer there, answers it. `/new`, `/space` and `/help` are commands
 *   (see shared/commands.ts).
 *
 * It reads the number, its phones and codes as the system (who's linked is
 * what it's here to find out), and acts as the person, or the contact, for
 * everything they do. Meta sending a message again changes nothing: the
 * event is the same one. A retried delivery finds the calls it made answered
 * from the log, and what it makes has ids from the message, so it makes the
 * same ones.
 */
import type { Actor, Context, Event, ProcessorDef } from "../../../../runtime/mod.ts";
import type { WhatsAppCode } from "../collections/code.ts";
import type { WhatsAppPhone } from "../collections/phone.ts";
import type { WhatsAppSent } from "../collections/sent.ts";
import {
  type Command,
  commandOf,
  HELP,
  type Named,
  pickSpace,
  spaceName,
} from "../shared/commands.ts";
import { fetchMedia, markRead } from "../shared/graph.ts";
import { type Connected, connected, send } from "../shared/number.ts";
import { mediaOf, type WaMessage, wordsOf } from "../shared/payload.ts";
import { settingsOf } from "../shared/settings.ts";
import { may } from "../../../access/spaces/contract.ts";
import { CONTACT } from "../../../access/contacts/contract.ts";
import { GAP } from "../collections/number.ts";

type Received = { number: string; from: string; name?: string; message: WaMessage };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wrong codes a phone may send in an hour. */
const TRIES = 5;

export const receiveProcessor: ProcessorDef = {
  on: "whatsapp.received",
  key: (event) => `${event.data.number}:${event.data.from}`,
  run: async (ctx, event) => {
    const received = event.data as Received;
    const on = await connected(ctx, received.number);
    if (!on) return;
    const phone = await ctx.as().db.collection<WhatsAppPhone>("whatsapp_phone")
      .findOne({ _id: `${on.number._id}:${received.from}` });
    if (phone?.person) return await linked(ctx, on, received, phone, event);
    // Blocked by the number's people: what it sends goes nowhere, and nothing is said.
    if (phone?.blocked) return;
    const code = await tried(ctx, on, received, phone);
    if (code === "linked") return;
    if (on.number.open) return await customer(ctx, on, received, phone, event);
    return await stranger(ctx, on, received, phone, code);
  },
};

/** Says something to the phone; a courtesy that fails is let go (Meta's refusals are noted). */
const say = (ctx: Context, on: Connected, to: string, text: string) =>
  send(ctx, on, to, text).catch(() => "");

/**
 * A code a phone sent, tried: one the app gave a person, unexpired, links
 * the phone to them (`linked`); another counts as a wrong try (`wrong`),
 * and five in an hour stop it being listened to for a while (`ignored`).
 * Anything else isn't a code (undefined).
 */
async function tried(
  ctx: Context,
  on: Connected,
  { from, name, message }: Received,
  phone: WhatsAppPhone | null,
): Promise<"linked" | "wrong" | "ignored" | undefined> {
  const code = /^\s*(?:link\s+)?(\d{3})[\s-]?(\d{3})\s*$/i.exec(wordsOf(message));
  if (!code) return undefined;
  const system = ctx.as().db;
  const _id = `${on.number._id}:${from}`;
  const now = Date.now();
  const at = new Date(now).toISOString();
  const base = { number: on.number._id, phone: from, ...(name ? { name } : {}), at };
  const counting = phone?.since && now - Date.parse(phone.since) < HOUR;
  const tries = counting ? phone?.tries ?? 0 : 0;
  // Guessing: it's no longer listened to, for a while.
  if (tries >= TRIES) return "ignored";
  const codes = system.collection<WhatsAppCode>("whatsapp_code");
  const found = await codes.findOne({ _id: `${on.number._id}:${code[1]}${code[2]}` });
  if (!found || Date.parse(found.expires) <= now) {
    await system.collection("whatsapp_phone").updateOne(
      { _id },
      { $set: { ...base, tries: tries + 1, since: counting ? phone!.since! : at } },
      { upsert: true },
    );
    return "wrong";
  }
  // Linked: theirs now, and no longer anyone's customer.
  await ctx.as().transaction(async (tx) => {
    await tx.db.collection("whatsapp_phone").replaceOne(
      { _id },
      { ...base, person: found.person, linked: at },
      { upsert: true },
    );
    await tx.db.collection("whatsapp_code").deleteMany({
      person: found.person,
      number: on.number._id,
    });
  });
  await markRead(on.graph, message.id, false).catch(() => {});
  const space = await spaceOf(ctx, { kind: "person", id: found.person }, undefined);
  await say(
    ctx,
    on,
    from,
    `You're linked${name ? `, ${name}` : ""}! What you send here goes to your agents in ` +
      `*${space.name}*, and they answer here.\n\nSend /help to see what else you can do.`,
  );
  return "linked";
}

/** A phone nobody has linked, on a number that isn't open: how to link it, once a day. */
async function stranger(
  ctx: Context,
  on: Connected,
  { from, name }: Received,
  phone: WhatsAppPhone | null,
  code: "wrong" | "ignored" | undefined,
) {
  if (code === "ignored") return;
  if (code === "wrong") {
    return void await say(
      ctx,
      on,
      from,
      "That code didn't match. Codes work for a few minutes: get a new one in the app, " +
        "and send it here.",
    );
  }
  const now = Date.now();
  if (phone?.told && now - Date.parse(phone.told) < DAY) return;
  const at = new Date(now).toISOString();
  await ctx.as().db.collection("whatsapp_phone").updateOne(
    { _id: `${on.number._id}:${from}` },
    { $set: { number: on.number._id, phone: from, ...(name ? { name } : {}), at, told: at } },
    { upsert: true },
  );
  const where = on.number.url ? ` at ${on.number.url}` : "";
  await say(
    ctx,
    on,
    from,
    `Hi! To talk to your agents here, link this phone first: sign in${where}, open the ` +
      `space this number belongs to, and under WhatsApp choose *Link my phone*. Then send the ` +
      `code it shows you here.`,
  );
}

/**
 * A customer on an open number: a contact (made from their first message,
 * so a retry makes the same one), writing in their chat there, as them.
 * Their chat is the one they're in, unless it's been quiet for the number's
 * gap, or they can't reach it anymore: then it's a new one.
 */
async function customer(
  ctx: Context,
  on: Connected,
  received: Received,
  phone: WhatsAppPhone | null,
  event: Event,
) {
  const { from, name, message } = received;
  const system = ctx.as();
  // Too many at once: let go, unanswered (each answer costs a model's turn and Meta's message).
  if (await flooding(ctx, on, `${on.number._id}:${from}`, event)) return;
  const contact = await contactOf(ctx, on, received, phone, event);
  await markRead(on.graph, message.id, true).catch(() => {});
  const lines = CUSTOMERS[on.number.language ?? "en"];
  const brings = await broughtBy(ctx, on, from, message, lines);
  if (!brings) return;

  const as = ctx.as({ kind: "contact", id: contact });
  const sender = `${CONTACT}${contact}`;
  const sending = async (thread: string) => {
    const replyTo = await answering(ctx, as, sender, thread, message);
    return await as.call("chat.send", { thread, ...brings, ...(replyTo ? { replyTo } : {}) });
  };
  const quiet = (on.number.gap ?? GAP) * HOUR;
  const current = phone?.thread
    ? await system.db.collection<{ _id: string; at: string }>("thread")
      .findOne({ _id: phone.thread })
    : null;
  const ongoing = current && Date.parse(event.at) - Date.parse(current.at) < quiet;
  const fresh = () => chatFor(ctx, on, { from, name, contact }, event);
  try {
    await sending(ongoing ? current!._id : await fresh());
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Taken out of their chat by its people: heard again only once it's been quiet for the gap.
    if (ongoing && (code === "duplicate_key" || code === "forbidden")) return;
    if (!await told(ctx, on, from, error, lines)) throw error;
  }
}

/** Messages a customer may send a minute, unless the number says otherwise. */
const RATE = 20;

/**
 * Whether a customer's phone sent more than its number allows in a minute
 * (`rate`), counting this message: counted in memory, by the minute.
 */
async function flooding(ctx: Context, on: Connected, phone: string, event: Event) {
  const counts = ctx.as().db.collection<{ minute: number; count: number }>("whatsapp_rate");
  const minute = Math.floor(Date.parse(event.at) / 60_000);
  const had = await counts.findOne({ _id: phone });
  const count = had?.minute === minute ? had.count + 1 : 1;
  await counts.replaceOne({ _id: phone }, { minute, count }, { upsert: true });
  return count > (on.number.rate ?? RATE);
}

/**
 * What customers are told when their message can't go on, in the number's
 * language: in their terms, never an error's own words.
 */
type Lines = { large: string; kind: string; voice: string; failed: string };
const CUSTOMERS: Record<"en" | "pt", Lines> = {
  en: {
    large: "That file is too large. Send a smaller one, or a link to it.",
    kind: "I can't read that kind of message yet: send text, a photo, a document or a voice note.",
    voice: "I couldn't make out that voice note. Could you say it again, or write it?",
    failed: "Sorry, I couldn't take that message. Please try again in a moment.",
  },
  pt: {
    large: "Esse arquivo é grande demais. Envie um menor, ou um link para ele.",
    kind:
      "Ainda não consigo ler esse tipo de mensagem: envie texto, uma foto, um documento ou um áudio.",
    voice: "Não consegui entender esse áudio. Pode repetir, ou escrever?",
    failed: "Desculpe, não consegui receber essa mensagem. Tente de novo em instantes.",
  },
};

/**
 * The contact a customer's phone is: made from their first message (its id
 * from it, so a retry makes the same one), and named as their WhatsApp
 * profile is, as that changes.
 */
async function contactOf(
  ctx: Context,
  on: Connected,
  { name }: Received,
  phone: WhatsAppPhone | null,
  event: Event,
) {
  if (phone?.contact && (!name || name === phone.name)) return phone.contact;
  const system = ctx.as();
  const { contact } = await system.call<{ contact: string }>("contact.start", {
    id: phone?.contact ?? `c-${(await digest(event.id)).slice(0, 24)}`,
    in: on.number.in,
    via: "whatsapp",
    ...(name ? { name } : {}),
  });
  if (phone?.contact) {
    await system.db.collection("whatsapp_phone").updateOne({ _id: phone._id }, { $set: { name } });
  }
  return contact;
}

/**
 * A new chat for a customer: opened for their contact in the number's
 * space (by the number's agent, while it still answers there), with an id
 * from this message, and noted as theirs on WhatsApp before anything is said
 * in it, so what agents answer there goes out at once.
 */
async function chatFor(
  ctx: Context,
  on: Connected,
  { from, name, contact }: { from: string; name?: string; contact: string },
  event: Event,
) {
  const system = ctx.as();
  const thread = `whatsapp-${(await digest(event.id)).slice(0, 32)}`;
  const open = (agent?: string) =>
    system.call("contact.chat", {
      contact,
      in: on.number.in,
      thread,
      ...(agent ? { agent } : {}),
      ...(name ? { title: name } : {}),
    });
  try {
    await open(on.number.agent);
  } catch (error) {
    // Its agent no longer answers in the space: who answers new chats there does.
    if ((error as { code?: string }).code !== "not_here") throw error;
    await open();
  }
  const at = new Date().toISOString();
  await system.transaction(async (tx) => {
    await tx.db.collection("whatsapp_phone").updateOne(
      { _id: `${on.number._id}:${from}` },
      {
        $set: {
          number: on.number._id,
          phone: from,
          ...(name ? { name } : {}),
          contact,
          thread,
          at,
        },
      },
      { upsert: true },
    );
    await tx.db.collection("whatsapp_thread").replaceOne(
      { _id: thread },
      { number: on.number._id, phone: from, contact, at },
      { upsert: true },
    );
  });
  return thread;
}

/**
 * What a message brings to say: its words, and its file (fetched from
 * Meta). Undefined when there's nothing to pass on, once the phone was told
 * why (a file too large, a kind of message agents can't read).
 */
async function broughtBy(
  ctx: Context,
  on: Connected,
  from: string,
  message: WaMessage,
  lines?: Lines,
) {
  const words = wordsOf(message).trim();
  const media = mediaOf(message);
  const files: { name: string; type: string; data: string }[] = [];
  if (media) {
    try {
      const got = await fetchMedia(on.graph, media.id, settingsOf(ctx).maxFileBytes);
      files.push({ name: media.name, type: got.type || media.type, data: got.data });
    } catch (error) {
      if ((error as { code?: string }).code !== "too_large") throw error;
      await say(
        ctx,
        on,
        from,
        lines?.large ?? `${(error as Error).message} Send a smaller one, or a link to it.`,
      );
      return undefined;
    }
  }
  if (!words && !files.length) {
    await say(
      ctx,
      on,
      from,
      lines?.kind ??
        "I can't pass that kind of message on yet: send text, a photo, a document or a voice note.",
    );
    return undefined;
  }
  return { ...(words ? { text: words } : {}), ...(files.length ? { files } : {}) };
}

/**
 * Tells the phone why its message couldn't be sent, when that's for them to
 * know: whether it did. A customer is told in its number's `lines`, never in
 * an error's own words.
 */
async function told(ctx: Context, on: Connected, from: string, error: unknown, lines?: Lines) {
  const failed = error as { code?: string; message?: string };
  if (failed.code === "transcription_failed") {
    await say(
      ctx,
      on,
      from,
      lines?.voice ?? "I couldn't make out that voice note. Could you say it again, or write it?",
    );
  } else if (failed.code === "not_here" || failed.code === "invalid") {
    await say(ctx, on, from, lines?.failed ?? failed.message ?? "That couldn't be sent.");
  } else return false;
  return true;
}

/** The space someone's messages go to: the one they chose while they may write there, else Personal. */
async function spaceOf(
  ctx: Context,
  person: Actor,
  chosen: string | undefined,
): Promise<{ _id: string; name: string; chosen: boolean }> {
  const as = ctx.as(person);
  if (chosen) {
    const found = await as.db.collection<Named>("space").findOne({ _id: chosen });
    if (found && !found.archived) return { _id: found._id, name: spaceName(found), chosen: true };
  }
  const { space } = await as.call<{ space: string }>("space.personal", {});
  return { _id: space, name: "Personal", chosen: false };
}

/** A linked phone's message: a command, or what they say to their agents. */
async function linked(
  ctx: Context,
  on: Connected,
  { from, message }: Received,
  phone: WhatsAppPhone,
  event: Event,
) {
  const person: Actor = { kind: "person", id: phone.person! };
  const as = ctx.as(person);
  const system = ctx.as().db;
  const phones = system.collection("whatsapp_phone");
  // Still in the number's space. (Asked, not read: what this job reads as them labels what
  // it writes, and their message isn't from there.)
  if (!await may(as, "read", on.number.in)) {
    await phones.deleteOne({ _id: phone._id });
    await say(
      ctx,
      on,
      from,
      "You're no longer in the space this number belongs to, so it can't reach your agents. " +
        "Ask its managers to add you back.",
    );
    return;
  }
  await markRead(on.graph, message.id, true).catch(() => {});
  const command = message.type === "text" ? commandOf(wordsOf(message).trim()) : undefined;
  if (command) return await commanded(ctx, on, from, phone, command);
  const brings = await broughtBy(ctx, on, from, message);
  if (!brings) return;

  const space = await spaceOf(ctx, person, phone.space);
  const sending = async (thread: string) => {
    const replyTo = await answering(ctx, as, person.id, thread, message);
    return await as.call("chat.send", {
      thread,
      in: space._id,
      ...brings,
      ...(replyTo ? { replyTo } : {}),
    });
  };
  try {
    await sending(phone.thread ?? await opened(ctx, on, phone, event));
  } catch (error) {
    let last = error;
    const code = (error as { code?: string }).code;
    // Their conversation is out of reach now (moved, gone): a new one, once.
    if (phone.thread && (code === "duplicate_key" || code === "forbidden")) {
      try {
        return void await sending(await opened(ctx, on, { ...phone, thread: undefined }, event));
      } catch (again) {
        last = again;
      }
    }
    if (await told(ctx, on, from, last)) return;
    if ((last as { code?: string }).code === "forbidden" && space.chosen) {
      await phones.updateOne({ _id: phone._id }, { $unset: { space: "", thread: "" } });
      await say(
        ctx,
        on,
        from,
        `You can't write in *${space.name}* anymore, so your messages go to Personal again. ` +
          "Send that once more.",
      );
    } else throw last;
  }
}

/**
 * A new WhatsApp conversation for the phone: its id, noted before anything
 * is said in it, so what agents answer there goes out at once.
 */
async function opened(ctx: Context, on: Connected, phone: WhatsAppPhone, event: Event) {
  // From the message, so a retry opens the same one.
  const thread = `whatsapp-${(await digest(event.id)).slice(0, 32)}`;
  await ctx.as().transaction(async (tx) => {
    await tx.db.collection("whatsapp_phone").updateOne({ _id: phone._id }, { $set: { thread } });
    await tx.db.collection("whatsapp_thread").replaceOne(
      { _id: thread },
      {
        number: on.number._id,
        phone: phone.phone,
        person: phone.person!,
        at: new Date().toISOString(),
      },
      { upsert: true },
    );
  });
  return thread;
}

const digest = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The message this one answers: the agent's message it quotes, else the
 * latest question an agent waits on them (`sender`, as messages name them)
 * for in this conversation (only its messages are read, as them: what this
 * job reads labels what it writes).
 */
async function answering(
  ctx: Context,
  as: Context,
  sender: string,
  thread: string,
  message: WaMessage,
) {
  const quoted = message.context?.id;
  if (quoted) {
    const sent = await ctx.as().db.collection<WhatsAppSent>("whatsapp_sent")
      .findOne({ wamid: quoted });
    if (sent) return sent.message;
  }
  const asked = await as.db.collection<{ _id: string }>("message").find(
    { thread, to: sender, replyTo: { $exists: false }, expectReply: { $ne: false } },
    { sort: { at: -1 }, limit: 5 },
  );
  const waits = ctx.as().db.collection("wait");
  for (const question of asked) {
    if (await waits.findOne({ waitingFor: question._id })) return question._id;
  }
  return undefined;
}

/** `/new`, `/space [name]`, `/help`. */
async function commanded(
  ctx: Context,
  on: Connected,
  from: string,
  phone: WhatsAppPhone,
  command: Command,
) {
  const person: Actor = { kind: "person", id: phone.person! };
  const phones = ctx.as().db.collection("whatsapp_phone");
  const here = await spaceOf(ctx, person, phone.space);
  if (command.name === "help") return void await say(ctx, on, from, HELP);
  if (command.name === "new") {
    await phones.updateOne({ _id: phone._id }, { $unset: { thread: "" } });
    return void await say(
      ctx,
      on,
      from,
      `Starting fresh: your next message begins a new conversation in *${here.name}*.`,
    );
  }
  // The spaces they're in, as the rules let them read them.
  const reached = (await ctx.as(person).db.collection<Named>("space").find({}))
    .filter((s) => !s.archived);
  const list = reached.map((s) => spaceName(s)).sort((a, b) =>
    a === "Personal" ? -1 : b === "Personal" ? 1 : a.localeCompare(b)
  ).join(", ");
  if (!command.arg) {
    return void await say(
      ctx,
      on,
      from,
      `You're talking in *${here.name}*.\nYour spaces: ${list}.\n\nSend /space <name> to switch.`,
    );
  }
  const picked = pickSpace(reached, command.arg);
  if (!picked) {
    return void await say(ctx, on, from, `No space called "${command.arg}". Yours: ${list}.`);
  }
  if (!await may(ctx.as(person), "write", picked._id)) {
    return void await say(
      ctx,
      on,
      from,
      `You can read *${spaceName(picked)}*, not write there: pick another.`,
    );
  }
  await phones.updateOne(
    { _id: phone._id },
    { $set: { space: picked._id }, $unset: { thread: "" } },
  );
  await say(
    ctx,
    on,
    from,
    `Now talking in *${spaceName(picked)}*: your next message starts a conversation there.`,
  );
}
