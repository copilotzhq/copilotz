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
 *   lasts and its line is the app's. Not counted again, nor asked the line's
 *   challenge again. One erased, past its time, or of another line, is a
 *   newcomer.
 * - **A newcomer:** counted on each network its address is in (`networksOf`:
 *   the address, then its /24, or its /56 and /48), within the line's new
 *   visitors an hour from each (`ipVisitorsPerHour`, as many times as the
 *   network counts), each taken in one write that counts only while there's
 *   room; past any, it's refused (`too_many`, saying so to anyone), and
 *   nobody else. Then, when the line has a `challenge`, the page's answer
 *   must pass it.
 *
 * The visitor it answers carries what its messages are counted by, as the
 * server issued it: its line (`web`) and its networks' tags (`from`, never
 * the address), so nothing is kept for it until it speaks. Unrecorded: its
 * result is the secret.
 */
import { defineAction, failure, networksOf, scaleOf } from "../../../../runtime/mod.ts";
import type { Visitor } from "../collections/visitor.ts";
import { contactOf, newSecret, tagsOf, type Visit, visitOf } from "../shared/secret.ts";
import { keyringOf, lineOf } from "../shared/web.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** What a newcomer is told when a line can't take them. */
const SAID = {
  address: "Too many new visitors from here: try again later.",
  none: "There's no such chat here.",
  challenge: "This chat asks you to show you're a person first: reload the page, then try again.",
} as const;

export const arriveAction = defineAction({
  description: "Lets a newcomer in by one of the app's web lines: the visitor, and its secret",
  record: false,
  input: {
    type: "object",
    properties: {
      line: { type: "string", minLength: 1, maxLength: 60 },
      /** The caller's address, as it's counted (never kept: its networks' tags are, HMACs). */
      address: { type: "string", minLength: 1, maxLength: 80 },
      /** The secret its cookie holds, which says nobody yet. */
      secret: { type: "string", maxLength: 512 },
      /** What the page answered the line's challenge with (a CAPTCHA's token). */
      challenge: { type: "string", maxLength: 4096 },
    },
    required: ["line"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const ring = keyringOf(ctx);
    const now = Date.now();
    const system = ctx.as();
    const rates = system.db.collection<{ until: number; count?: number }>("contact_rate");
    const admitted = async (visit: Visit, secret: string) => {
      const contact = await contactOf(ring!, visit);
      const line = lineOf(ctx, visit.line)!;
      const left = (visit.issued + line.days * DAY - now) / DAY;
      return {
        actor: { kind: "contact", id: contact, web: line.name, from: visit.tags },
        secret,
        days: left,
      };
    };

    // Back with its secret, not yet spoken, by the same line: the same visitor, while it lasts.
    const back = ring && input.secret ? await visitOf(ring, input.secret) : undefined;
    const backLine = back?.line === input.line ? lineOf(ctx, back.line) : undefined;
    if (back && backLine && back.issued + backLine.days * DAY > now + 60_000) {
      const known = await system.db.collection<Visitor>("contact_visitor")
        .findOne({ _id: await contactOf(ring!, back) });
      if (!known) return await admitted(back, input.secret!);
    }

    const line = lineOf(ctx, input.line);
    if (!line || !ring) throw failure("not_found", SAID.none, { public: true });
    const tags = input.address ? await tagsOf(ring, line.name, networksOf(input.address)) : [];
    if (tags.length) {
      const hour = Math.floor(now / HOUR) * HOUR;
      const counters = tags.map((tag) => ({
        _id: `${line.name}|ip|${tag}@${hour}`,
        most: line.limits.ipVisitorsPerHour * scaleOf(tag),
      }));
      // A full one refuses it at once, nothing taken; else each place in one write, narrowest first.
      const counts = new Map(
        (await rates.find({ _id: { $in: counters.map((c) => c._id) } }))
          .map((c) => [c._id, c.count ?? 0]),
      );
      if (counters.some((c) => (counts.get(c._id) ?? 0) >= c.most)) {
        throw failure("too_many", SAID.address, { public: true });
      }
      for (const c of counters) {
        try {
          await rates.updateOne(
            { _id: c._id, count: { $lt: c.most } },
            { $inc: { count: 1 }, $set: { until: hour + HOUR } },
            { upsert: true },
          );
        } catch (error) {
          // Full: the counter is there, past the filter, so the upsert finds its id taken.
          if ((error as { code?: string }).code !== "duplicate_key") throw error;
          throw failure("too_many", SAID.address, { public: true });
        }
      }
    }
    if (line.challenge) {
      const passed = input.challenge
        ? await system.call<unknown>(line.challenge, { line: line.name, answer: input.challenge })
        : false;
      if (passed !== true) throw failure("forbidden", SAID.challenge, { public: true });
    }
    const secret = await newSecret(ring, line.name, tags);
    return await admitted((await visitOf(ring, secret))!, secret);
  },
});
