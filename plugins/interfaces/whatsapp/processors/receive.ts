/**
 * What someone sent a connected number (`whatsapp.received`), handled in
 * order for each phone:
 *
 * - **A stranger** (a phone not linked to anyone) is told how to link it,
 *   once a day, and nothing else. A six-digit code they send is tried:
 *   one the app gave a person, unexpired, links the phone to them (five
 *   wrong ones in an hour, and it stops listening to codes for a while).
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
 * what it's here to find out), and acts as the person for everything they
 * do. Meta sending a message again changes nothing: the event is the same
 * one. A retried delivery finds the calls it made answered from the log.
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
    if (!phone?.person) return await stranger(ctx, on, received, phone);
    return await linked(ctx, on, received, phone, event);
  },
};

/** Says something to the phone; a courtesy that fails is let go (Meta's refusals are noted). */
const say = (ctx: Context, on: Connected, to: string, text: string) =>
  send(ctx, on, to, text).catch(() => "");

/** A phone nobody has linked: a code may link it; otherwise, how to, once a day. */
async function stranger(
  ctx: Context,
  on: Connected,
  { from, name, message }: Received,
  phone: WhatsAppPhone | null,
) {
  const system = ctx.as().db;
  const phones = system.collection("whatsapp_phone");
  const _id = `${on.number._id}:${from}`;
  const now = Date.now();
  const at = new Date(now).toISOString();
  const base = { number: on.number._id, phone: from, ...(name ? { name } : {}), at };
  const code = /^\s*(?:link\s+)?(\d{3})[\s-]?(\d{3})\s*$/i.exec(wordsOf(message));
  if (code) {
    const counting = phone?.since && now - Date.parse(phone.since) < HOUR;
    const tries = counting ? phone?.tries ?? 0 : 0;
    // Guessing: it's no longer listened to, for a while.
    if (tries >= TRIES) return;
    const codes = system.collection<WhatsAppCode>("whatsapp_code");
    const found = await codes.findOne({ _id: `${on.number._id}:${code[1]}${code[2]}` });
    if (found && Date.parse(found.expires) > now) {
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
      return;
    }
    await phones.updateOne(
      { _id },
      { $set: { ...base, tries: tries + 1, since: counting ? phone!.since! : at } },
      { upsert: true },
    );
    await say(
      ctx,
      on,
      from,
      "That code didn't match. Codes work for a few minutes: get a new one in the app, " +
        "and send it here.",
    );
    return;
  }
  if (phone?.told && now - Date.parse(phone.told) < DAY) return;
  await phones.updateOne({ _id }, { $set: { ...base, told: at } }, { upsert: true });
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
  const words = wordsOf(message).trim();
  const command = message.type === "text" ? commandOf(words) : undefined;
  if (command) return await commanded(ctx, on, from, phone, command);

  // What it brings: its words, and its file.
  const media = mediaOf(message);
  const files: { name: string; type: string; data: string }[] = [];
  if (media) {
    try {
      const got = await fetchMedia(on.graph, media.id, settingsOf(ctx).maxFileBytes);
      files.push({ name: media.name, type: got.type || media.type, data: got.data });
    } catch (error) {
      if ((error as { code?: string }).code !== "too_large") throw error;
      await say(ctx, on, from, `${(error as Error).message} Send a smaller one, or a link to it.`);
      return;
    }
  }
  if (!words && !files.length) {
    await say(
      ctx,
      on,
      from,
      "I can't pass that kind of message on yet: send text, a photo, a document or a voice note.",
    );
    return;
  }

  const space = await spaceOf(ctx, person, phone.space);
  const sending = async (thread: string) => {
    const replyTo = await answering(ctx, person, thread, message);
    return await as.call("chat.send", {
      thread,
      in: space._id,
      ...(words ? { text: words } : {}),
      ...(files.length ? { files } : {}),
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
    const failed = last as { code?: string; message?: string };
    if (failed.code === "transcription_failed") {
      await say(
        ctx,
        on,
        from,
        "I couldn't make out that voice note. Could you say it again, or write it?",
      );
    } else if (failed.code === "not_here" || failed.code === "invalid") {
      await say(ctx, on, from, failed.message ?? "That couldn't be sent.");
    } else if (failed.code === "forbidden" && space.chosen) {
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
 * latest question an agent waits on them for in this conversation (only
 * its messages are read: what this job reads labels what it writes).
 */
async function answering(ctx: Context, person: Actor, thread: string, message: WaMessage) {
  const quoted = message.context?.id;
  if (quoted) {
    const sent = await ctx.as().db.collection<WhatsAppSent>("whatsapp_sent")
      .findOne({ wamid: quoted });
    if (sent) return sent.message;
  }
  const asked = await ctx.as(person).db.collection<{ _id: string }>("message").find(
    { thread, to: person.id, replyTo: { $exists: false }, expectReply: { $ne: false } },
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
