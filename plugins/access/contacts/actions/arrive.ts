/**
 * `contact.arrive`: a browser on one of the app's web lines that isn't
 * anyone yet, asking to come in: the visitor it is, and the secret its
 * browser keeps, in an httpOnly cookie the web host sets. Nothing is made
 * or kept: the secret stands on its own (signed, see shared/secret.ts), and
 * the visitor's contact, chat and record come with its first message
 * (`contact.sending`). Only the system calls it: the contacts' entrance, for
 * the web host, with the caller's address as it's counted (`address`: the
 * app's front's word for it, else its socket's; none for a caller exempt
 * from limits by address).
 *
 * - **Back with its secret** (`secret`: its cookie, which says nobody yet:
 *   it hasn't spoken), by the same line: the same visitor, while the secret
 *   lasts and its line is the app's. Not counted again. One erased, past its
 *   time, or of another line, is a newcomer.
 * - **A newcomer:** counted on its address, within the line's new visitors
 *   an hour from one (`ipVisitorsPerHour`), taken in one write that counts
 *   only while there's room; past it, that address is refused (`too_many`,
 *   saying so to anyone), and nobody else.
 *
 * Either way it notes, in memory, where the visitor's messages are counted
 * from (the tag of its address, never the address) until its first message
 * keeps it with the visitor. Unrecorded: its result is the secret.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Visitor } from "../collections/visitor.ts";
import { contactOf, newSecret, tagOf, type Visit, visitOf } from "../shared/secret.ts";
import { keyringOf, lineOf } from "../shared/web.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The tag of visitors exempt from limits by address: counted by none. */
export const EXEMPT = "0".repeat(16);

/** What a newcomer is told when a line can't take them. */
const SAID = {
  address: "Too many new visitors from here: try again later.",
  none: "There's no such chat here.",
} as const;

/** A write whose answer isn't needed. */
const UNANSWERED = { writeConcern: { w: 0 } } as const;

export const arriveAction = defineAction({
  description: "Lets a newcomer in by one of the app's web lines: the visitor, and its secret",
  record: false,
  input: {
    type: "object",
    properties: {
      line: { type: "string", minLength: 1, maxLength: 60 },
      /** The caller's address, as it's counted (never kept: its tag is, an HMAC of it). */
      address: { type: "string", minLength: 1, maxLength: 80 },
      /** The secret its cookie holds, which says nobody yet. */
      secret: { type: "string", maxLength: 512 },
    },
    required: ["line"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const ring = keyringOf(ctx);
    const now = Date.now();
    const system = ctx.as().db;
    const rates = system.collection<{ until: number; count?: number; tag?: string }>(
      "contact_rate",
    );
    /** Where its messages are counted from, until its first message keeps it with it. */
    const noted = async (visit: Visit, secret: string) => {
      const contact = await contactOf(ring!, visit);
      await rates.updateOne(
        { _id: `from|${contact}` },
        { $set: { tag: visit.tag, until: now + DAY } },
        { upsert: true, ...UNANSWERED },
      );
      const line = lineOf(ctx, visit.line)!;
      const left = (visit.issued + line.days * DAY - now) / DAY;
      return { actor: { kind: "contact", id: contact, web: line.name }, secret, days: left };
    };

    // Back with its secret, not yet spoken, by the same line: the same visitor, while it lasts.
    const back = ring && input.secret ? await visitOf(ring, input.secret) : undefined;
    const backLine = back?.line === input.line ? lineOf(ctx, back.line) : undefined;
    if (back && backLine && back.issued + backLine.days * DAY > now + 60_000) {
      const known = await system.collection<Visitor>("contact_visitor")
        .findOne({ _id: await contactOf(ring!, back) });
      if (!known) return await noted(back, input.secret!);
    }

    const line = lineOf(ctx, input.line);
    if (!line || !ring) throw failure("not_found", SAID.none, { public: true });
    const tag = input.address ? await tagOf(ring, line.name, input.address) : EXEMPT;
    if (input.address) {
      const hour = Math.floor(now / HOUR) * HOUR;
      try {
        await rates.updateOne(
          { _id: `${line.name}|ip|${tag}@${hour}`, count: { $lt: line.limits.ipVisitorsPerHour } },
          { $inc: { count: 1 }, $set: { until: hour + HOUR } },
          { upsert: true },
        );
      } catch (error) {
        // Full: the counter is there, past the filter, so the upsert finds its id taken.
        if ((error as { code?: string }).code !== "duplicate_key") throw error;
        throw failure("too_many", SAID.address, { public: true });
      }
    }
    const secret = await newSecret(ring, line.name, tag);
    return await noted((await visitOf(ring, secret))!, secret);
  },
});
