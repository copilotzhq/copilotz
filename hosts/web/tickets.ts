/**
 * Tickets: what a signed-in browser trades its session for, to connect. The
 * session stays in an httpOnly cookie its code never sees; a ticket works
 * once, for a minute, and the runtime's `admit` turns it into the person.
 *
 * Each actor has `perMinute` tickets a minute (30 unless said), however many
 * tabs and reconnects that is: past it, `issue` refuses (a public `too_many`
 * failure, its `retryAfter` the seconds until the minute's out), and
 * `/connect` answers 429. Tickets past their minute are dropped as they pass
 * (see runtime/expiring.ts), never by looking through them all.
 *
 * ```ts
 * const tickets = createTickets();
 * const runtime = await createRuntime({ store, plugins, admit: tickets.admit });
 * ```
 */
import type { Actor } from "../../runtime/mod.ts";
import { failure } from "../../runtime/errors.ts";
import { expiring } from "../../runtime/expiring.ts";

export type Tickets = {
  /** A ticket for this actor, for one connection; refused (`too_many`) past its minute's. */
  issue(actor: Actor): string;
  /** Who a ticket is for, once; undefined when it's unknown, used or old. */
  admit(ticket: string): Actor | undefined;
};

const MINUTE = 60_000;

export function createTickets(options: { ms?: number; perMinute?: number } = {}): Tickets {
  const perMinute = options.perMinute ?? 30;
  const issued = expiring<string, Actor>(options.ms ?? 60_000);
  /** Each actor's tickets this minute, and when its minute began. */
  const counted = expiring<string, { count: number; since: number }>(MINUTE);
  return {
    issue(actor) {
      const who = `${actor.kind}:${actor.id}`;
      const now = Date.now();
      const minute = counted.get(who) ?? { count: 0, since: now };
      if (minute.count >= perMinute) {
        throw Object.assign(
          failure("too_many", "Too many connections at once: try again in a minute", {
            public: true,
          }),
          { retryAfter: Math.max(1, Math.ceil((minute.since + MINUTE - now) / 1000)) },
        );
      }
      if (!minute.count) counted.set(who, minute);
      minute.count++;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      issued.set(ticket, actor);
      return ticket;
    },
    admit(ticket) {
      const actor = issued.get(ticket);
      issued.delete(ticket);
      return actor;
    },
  };
}
