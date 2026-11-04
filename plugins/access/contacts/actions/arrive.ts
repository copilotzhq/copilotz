/**
 * `contact.arrive`: a newcomer on one of the app's web lines (a browser that
 * isn't anyone, asking to come in): a contact now (`via: "web"`), in the
 * line's space, with a chat of its own there (`contact.chat`, answered by
 * the line's agent), and the secret its browser keeps, in an httpOnly
 * cookie the web host sets. Only the system calls it: the contacts'
 * entrance, for the web host, with the caller's address as the app's front
 * says it (`address`).
 *
 * Within the line's limits first: new visitors this hour from the caller's
 * address (`ipVisitorsPerHour`), then on the line (`visitorsPerHour`). Each
 * place is taken in one write, which counts only while there's room, before
 * anything's made: arrivals at once can't pass a limit, and past one, it's
 * refused (`too_many`, saying so to anyone) with nothing made. A place taken
 * by an arrival that then failed stays taken: the count leans to no.
 *
 * Unrecorded: its result is the secret. What it makes (the contact, its chat,
 * its membership) is on the record as each of those Actions and writes is;
 * the visitor's record keeps only the secret's hash.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import { lineOf } from "../shared/web.ts";
import { hashOf, newSecret } from "../shared/secret.ts";

const HOUR = 3_600_000;

/** What a newcomer is told when a line can't take them. */
const SAID = {
  address: "Too many new visitors from here: try again later.",
  busy: "This chat is busy right now: try again in a few minutes.",
  none: "There's no such chat here.",
} as const;

/** A write whose answer isn't needed. */
const UNANSWERED = { writeConcern: { w: 0 } } as const;

export const arriveAction = defineAction({
  description: "Lets a newcomer in by one of the app's web lines: a contact, its chat, its secret",
  record: false,
  input: {
    type: "object",
    properties: {
      line: { type: "string", minLength: 1, maxLength: 60 },
      /** The caller's address, as the app's front says it (counted; never kept). */
      address: { type: "string", minLength: 1, maxLength: 80 },
    },
    required: ["line"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const line = lineOf(ctx, input.line);
    if (!line) throw failure("not_found", SAID.none, { public: true });
    const now = Date.now();
    const hour = Math.floor(now / HOUR) * HOUR;
    const rates = ctx.db.collection<{ until: number; count: number }>("contact_rate");
    /** Takes a place under a counter, in one write: none left, it's refused. */
    const take = async (what: string, most: number, say: string) => {
      try {
        await rates.updateOne(
          { _id: `${line.name}|${what}@${hour}`, count: { $lt: most } },
          { $inc: { count: 1 }, $set: { until: hour + HOUR } },
          { upsert: true },
        );
      } catch (error) {
        // Full: the counter is there, past the filter, so the upsert finds its id taken.
        if ((error as { code?: string }).code !== "duplicate_key") throw error;
        throw failure("too_many", say, { public: true });
      }
    };
    await rates.deleteMany({ until: { $lte: now } }, UNANSWERED);
    if (input.address) {
      await take(`ip|${input.address}`, line.limits.ipVisitorsPerHour, SAID.address);
    }
    await take("all", line.limits.visitorsPerHour, SAID.busy);

    const contact = `c-${crypto.randomUUID()}`;
    await ctx.call("space.keep", { id: line.in });
    await ctx.call("contact.start", { id: contact, in: line.in, via: "web" });
    const { thread } = await ctx.call<{ thread: string }>("contact.chat", {
      contact,
      in: line.in,
      ...(line.agent ? { agent: line.agent } : {}),
      title: (line.title ?? line.name).slice(0, 120),
    });
    const secret = newSecret();
    await ctx.db.collection("contact_visitor").insertOne({
      _id: await hashOf(secret),
      contact,
      line: line.name,
      expires: new Date(now + line.days * 86_400_000).toISOString(),
      at: new Date(now).toISOString(),
    });
    return { actor: { kind: "contact", id: contact }, secret, days: line.days, thread };
  },
});
