/**
 * `contact.sending`: a contact about to send a message (chat's
 * `contactSend` hook, which `chat.send` asks as the contact, before
 * anything is sent). Contacts that aren't a web line's visitors (WhatsApp's,
 * a phone's) go as ever: their lines keep their own limits. A web line's
 * visitor (`actor.web`, its line):
 *
 * - **Its line's limits:** its messages a minute and a day, its address's
 *   (the tag of the one it first came from: every visitor that came from it),
 *   the line's a minute; and for its first message, the line's new visitors
 *   who speak, an hour. Past any, it's refused (`too_many`, saying which, to
 *   anyone). Each place is taken in one write that counts only while there's
 *   room, the visitor's own first: messages at once can't pass a limit, and
 *   one its own limits refuse takes nothing of its address's or the line's.
 * - **What it may carry:** files only when the line takes them (`files`),
 *   as many and as large as it says; audio goes untranscribed unless the
 *   line says (`transcribe`). Else it's refused (`invalid`, said to anyone).
 * - **Its first message** makes it someone, as the system: its contact
 *   (`contact.start`, `via: "web"`), its chat in the line's space, answered
 *   by the line's agent (`contact.chat`), its record (`contact_visitor`,
 *   `spoke: false` until `contact.prune` sees its message went in). Two
 *   first messages at once make the same ones (the chat's id comes from the
 *   contact's).
 *
 * It answers where the message goes (`thread`: the visitor's own chat, when
 * it names none) and, when the line doesn't transcribe, `transcribe: false`.
 * Unrecorded: what it makes is on the record as each of those Actions is.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Visitor } from "../collections/visitor.ts";
import { EXEMPT } from "./arrive.ts";
import { chatOf } from "../shared/secret.ts";
import { keyringOf, lineOf } from "../shared/web.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** What a visitor is told when its message can't go in. */
const SAID = {
  fast: "You're sending messages too fast: wait a minute, then try again.",
  day: "That's all the messages this chat takes today: come back tomorrow.",
  address: "Too many messages from here: wait a little, then try again.",
  busy: "This chat is busy right now: try again in a few minutes.",
  closed: "This chat is closed.",
  again: "This chat needs a fresh start: reload the page.",
  files: "This chat takes no files.",
  many: (n: number) => `This chat takes ${n} file${n === 1 ? "" : "s"} a message at most.`,
  large: (bytes: number) =>
    `Each file may be ${
      bytes >= 1_000_000 ? `${bytes / 1_000_000} MB` : `${Math.ceil(bytes / 1_000)} KB`
    } at most.`,
} as const;

/** Writes whose answer isn't needed. */
const UNANSWERED = { writeConcern: { w: 0 } } as const;

type Counter = { _id: string; most: number; until: number; say: string };

export const sendingAction = defineAction({
  description: "Lets a contact's message in: a web visitor's limits, and its own chat",
  record: false,
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      /** What it carries: each file's media type and size. */
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            size: { type: "integer" },
          },
          required: ["size"],
        },
      },
    },
    additionalProperties: false,
  },
  // Chat asks, as the contact; nobody outside calls it.
  run: async (ctx, input): Promise<{ thread?: string; transcribe?: false }> => {
    const actor = ctx.actor;
    const web = typeof actor?.web === "string" ? actor.web : undefined;
    // Not a web line's visitor: its line keeps its own limits.
    if (actor?.kind !== "contact" || !web) return {};
    const ring = keyringOf(ctx);
    const line = lineOf(ctx, web);
    if (!line || !ring) throw failure("forbidden", SAID.closed, { public: true });
    const files = input.files ?? [];
    if (files.length) {
      if (!line.files) throw failure("invalid", SAID.files, { public: true });
      if (files.length > line.files.count) {
        throw failure("invalid", SAID.many(line.files.count), { public: true });
      }
      if (files.some((f) => f.size > line.files!.bytes || (f.name ?? "").length > 255)) {
        throw failure("invalid", SAID.large(line.files.bytes), { public: true });
      }
    }
    const contact = actor.id;
    const system = ctx.as();
    const rates = system.db.collection<{ until: number; count?: number; tag?: string }>(
      "contact_rate",
    );
    const visitors = system.db.collection<Visitor>("contact_visitor");
    const [known, from] = await Promise.all([
      visitors.findOne({ _id: contact }),
      rates.findOne({ _id: `from|${contact}` }),
    ]);
    if (known?.ended) throw failure("forbidden", SAID.closed, { public: true });
    // Where its messages are counted from: the address it first came from, kept with it.
    const tag = known?.tag ?? from?.tag;
    if (!tag) throw failure("expired", SAID.again, { public: true });

    const now = Date.now();
    const minute = Math.floor(now / MINUTE) * MINUTE;
    const day = Math.floor(now / DAY) * DAY;
    const hour = Math.floor(now / HOUR) * HOUR;
    const at = (what: string, start: number, span: number, most: number, say: string) => ({
      _id: `${line.name}|${what}@${start}`,
      until: start + span,
      most,
      say,
    });
    const { limits } = line;
    const counters: Counter[] = [
      at(`c|${contact}`, minute, MINUTE, limits.perMinute, SAID.fast),
      at(`cday|${contact}`, day, DAY, limits.perDay, SAID.day),
      ...(tag !== EXEMPT
        ? [
          at(`a|${tag}`, minute, MINUTE, limits.ipPerMinute, SAID.address),
          at(`aday|${tag}`, day, DAY, limits.ipPerDay, SAID.address),
        ]
        : []),
      at("line", minute, MINUTE, limits.linePerMinute, SAID.busy),
      ...(known ? [] : [at("new", hour, HOUR, limits.visitorsPerHour, SAID.busy)]),
    ];
    // A full one refuses it at once, nothing taken. Else each place is taken in one write that
    // counts only while there's room, narrowest first: messages at once can't pass a limit, and
    // one refused by its own limits takes nothing from its address's or the line's.
    const counts = new Map(
      (await rates.find({ _id: { $in: counters.map((c) => c._id) } }))
        .map((c) => [c._id, c.count ?? 0]),
    );
    const full = counters.find((c) => (counts.get(c._id) ?? 0) >= c.most);
    if (full) throw failure("too_many", full.say, { public: true });
    for (const c of counters) {
      try {
        await rates.updateOne(
          { _id: c._id, count: { $lt: c.most } },
          { $inc: { count: 1 }, $set: { until: c.until } },
          { upsert: true },
        );
      } catch (error) {
        // Full: the counter is there, past the filter, so the upsert finds its id taken.
        if ((error as { code?: string }).code !== "duplicate_key") throw error;
        throw failure("too_many", c.say, { public: true });
      }
    }

    const transcribe = line.transcribe ? {} : { transcribe: false as const };
    if (known) return { thread: input.thread ?? known.thread, ...transcribe };

    // Its first message: its contact, its chat and its record, now.
    const thread = await chatOf(ring, contact);
    const open = async () => {
      await system.call("space.keep", { id: line.in });
      await system.call("contact.start", { id: contact, in: line.in, via: "web" });
      await system.call("contact.chat", {
        contact,
        in: line.in,
        thread,
        ...(line.agent ? { agent: line.agent } : {}),
        title: (line.title ?? line.name).slice(0, 120),
      });
    };
    // Two first messages at once both make them: the one that finds the other's made goes on.
    await open().catch(async (error) => {
      if ((error as { code?: string }).code !== "duplicate_key") throw error;
      await open();
    });
    await visitors.replaceOne({ _id: contact }, {
      _id: contact,
      line: line.name,
      thread,
      tag,
      spoke: false,
      expires: new Date(now + line.days * DAY).toISOString(),
      at: new Date(now).toISOString(),
    }, { upsert: true });
    await rates.deleteOne({ _id: `from|${contact}` }, UNANSWERED);
    return { thread: input.thread ?? thread, ...transcribe };
  },
});
