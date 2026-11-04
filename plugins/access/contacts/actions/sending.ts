/**
 * `contact.sending`: a contact about to send a message (chat's
 * `contactSend` hook, which `chat.send` asks as the contact, before
 * anything is sent). Contacts that aren't a web line's visitors (WhatsApp's,
 * a phone's) go as ever: their lines keep their own limits. A web line's
 * visitor (`actor.web`, its line):
 *
 * - **Its line's limits:** its messages a minute and a day; those from each
 *   network it first came from (the tags of its address's networks, as the
 *   server issued it: `actor.from`, then its record's), as many times the
 *   address's limits as the network counts; the line's a minute, of which
 *   newcomers (visitors who hadn't spoken before the minute) take only
 *   their share (`newcomersPerMinute`); and for its first message, new
 *   visitors who speak, on the line and from each of its networks, an hour.
 *   Past any, it's refused (`too_many`, saying which, to anyone). Each place
 *   is taken in one write that counts only while there's room, the
 *   visitor's own first, then its networks' narrowest first, then the
 *   line's: messages at once can't pass a limit, and one its own limits
 *   refuse takes nothing of its networks' or the line's.
 * - **Its line's budget:** what its visitors' turns were charged today
 *   (`contact.spent`, as the usage plugin prices them), and what's held for
 *   messages let in not yet charged: each holds an estimate as it goes in
 *   (see shared/budget.ts). Past it, it waits for tomorrow; with no room
 *   beside what's held, a moment.
 * - **What it may carry:** files only when the line takes them (`files`),
 *   as many and as large as it says, each saying what it is in a media type
 *   of 127 characters at most; audio goes untranscribed unless the line
 *   says (`transcribe`). Else it's refused (`invalid`, said to anyone).
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
import { defineAction, failure, scaleOf } from "../../../../runtime/mod.ts";
import { MEDIA_TYPE, MEDIA_TYPE_LENGTH } from "../../../agents/chat/contract.ts";
import type { Rate } from "../collections/rate.ts";
import type { Visitor } from "../collections/visitor.ts";
import { type Day, hold } from "../shared/budget.ts";
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
  spent: "This chat has done all it can for today: come back tomorrow.",
  closed: "This chat is closed.",
  again: "This chat needs a fresh start: reload the page.",
  files: "This chat takes no files.",
  many: (n: number) => `This chat takes ${n} file${n === 1 ? "" : "s"} a message at most.`,
  large: (bytes: number) =>
    `Each file may be ${
      bytes >= 1_000_000 ? `${bytes / 1_000_000} MB` : `${Math.ceil(bytes / 1_000)} KB`
    } at most.`,
  named: "Each file's name is 255 characters at most.",
  typed: "Each file says what it is in a media type (image/png), 127 characters at most.",
} as const;

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
            type: { type: "string", maxLength: MEDIA_TYPE_LENGTH },
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
      if (files.some((f) => f.size > line.files!.bytes)) {
        throw failure("invalid", SAID.large(line.files.bytes), { public: true });
      }
      if (files.some((f) => (f.name ?? "").length > 255)) {
        throw failure("invalid", SAID.named, { public: true });
      }
      const typed = (type?: string) =>
        type === undefined || (type.length <= MEDIA_TYPE_LENGTH && MEDIA_TYPE.test(type));
      if (files.some((f) => !typed(f.type))) {
        throw failure("invalid", SAID.typed, { public: true });
      }
    }
    const contact = actor.id;
    const system = ctx.as();
    const rates = system.db.collection<Rate>("contact_rate");
    const visitors = system.db.collection<Visitor>("contact_visitor");
    const known = await visitors.findOne({ _id: contact });
    if (known?.ended) throw failure("forbidden", SAID.closed, { public: true });
    // What its messages are counted by: the networks it first came from, as the server issued it.
    const issued = Array.isArray(actor.from) && actor.from.every((t) => typeof t === "string")
      ? actor.from as string[]
      : undefined;
    const tags = known?.tags ?? issued;
    if (!tags) throw failure("expired", SAID.again, { public: true });

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
    // A newcomer: one that hadn't spoken before this minute; the rest of the line's is kept.
    const newcomer = !known || Date.parse(known.at) >= minute;
    const counters: Counter[] = [
      at(`c|${contact}`, minute, MINUTE, limits.perMinute, SAID.fast),
      at(`cday|${contact}`, day, DAY, limits.perDay, SAID.day),
      ...tags.flatMap((tag) => [
        at(`a|${tag}`, minute, MINUTE, limits.ipPerMinute * scaleOf(tag), SAID.address),
        at(`aday|${tag}`, day, DAY, limits.ipPerDay * scaleOf(tag), SAID.address),
        ...(known
          ? []
          : [at(`anew|${tag}`, hour, HOUR, limits.ipVisitorsPerHour * scaleOf(tag), SAID.busy)]),
      ]),
      ...(newcomer ? [at("newcomers", minute, MINUTE, limits.newcomersPerMinute, SAID.busy)] : []),
      at("line", minute, MINUTE, limits.linePerMinute, SAID.busy),
      ...(known ? [] : [at("new", hour, HOUR, limits.visitorsPerHour, SAID.busy)]),
    ];
    const spent = `${line.name}|spent@${day}`;
    // A full one refuses it at once, nothing taken. Else each place is taken in one write that
    // counts only while there's room, narrowest first: messages at once can't pass a limit, and
    // one refused by its own limits takes nothing from its networks' or the line's.
    const found = new Map(
      (await rates.find({ _id: { $in: [...counters.map((c) => c._id), spent] } }))
        .map((c) => [c._id, c as Rate & Day]),
    );
    const today = found.get(spent);
    if (line.budget !== undefined && (today?.closed || (today?.spent ?? 0) >= line.budget)) {
      throw failure("too_many", SAID.spent, { public: true });
    }
    const full = counters.find((c) => (found.get(c._id)?.count ?? 0) >= c.most);
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
    // Its turn's cost, estimated, held against the line's budget until it's charged.
    if (line.budget !== undefined) {
      await hold(
        system.db.collection<Rate & Day>("contact_rate"),
        { name: line.name, budget: line.budget },
        contact,
        now,
      );
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
    // First messages at once all make them: one that finds another's made, as it writes, goes on.
    for (let tries = 1;; tries++) {
      try {
        await open();
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "duplicate_key" || tries === 5) throw error;
      }
    }
    await visitors.replaceOne({ _id: contact }, {
      _id: contact,
      line: line.name,
      thread,
      tags,
      spoke: false,
      expires: new Date(now + line.days * DAY).toISOString(),
      at: new Date(now).toISOString(),
    }, { upsert: true });
    return { thread: input.thread ?? thread, ...transcribe };
  },
});
