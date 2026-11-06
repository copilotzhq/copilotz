/**
 * Tickets: what a browser trades its credential for at `POST /connect`, to
 * open the runtime's socket. The credential stays where it is (an httpOnly
 * cookie the page's code never sees); a ticket works once, for a minute, and
 * the owner admits the socket that shows it as whoever it was issued for.
 *
 * Each actor has `perMinute` tickets a minute (30 unless said: the runtime's
 * `browsers.tickets`), however many tabs and reconnects that is: past it,
 * `issue` refuses (a public `too_many` failure, its `retryAfter` the seconds
 * until the minute's out), and `/connect` answers 429. Tickets past their
 * minute are dropped as they pass (see expiring.ts), never by looking
 * through them all. Ending an actor (`end`: signed out, erased) ends its
 * tickets not yet used.
 */
import type { Actor } from "./store.ts";
import { failure } from "./errors.ts";
import { expiring } from "./expiring.ts";

export type Tickets = {
  /** A ticket for this actor, for one connection; refused (`too_many`) past its minute's. */
  issue(actor: Actor): string;
  /** Who a ticket is for, once; undefined when it's unknown, used or old. */
  admit(ticket: string): Actor | undefined;
  /** Their tickets not yet used are no one's: what was handed out before lets nobody in after. */
  end(actor: Actor): void;
  /** Drops every ticket, and stops their timers. */
  close(): void;
};

const MINUTE = 60_000;

export function createTickets(options: { ms?: number; perMinute?: number } = {}): Tickets {
  const perMinute = options.perMinute ?? 30;
  const ms = options.ms ?? 60_000;
  const issued = expiring<string, Actor>(ms);
  /** Each actor's tickets this minute, and when its minute began. */
  const counted = expiring<string, { count: number; since: number }>(MINUTE);
  /** Each actor's tickets handed out lately (some used, or past), to end them all at once. */
  const theirs = expiring<string, string[]>(ms);
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
      const kept = (theirs.get(who) ?? []).filter((t) => issued.get(t));
      theirs.set(who, [...kept, ticket]);
      return ticket;
    },
    admit(ticket) {
      const actor = issued.get(ticket);
      issued.delete(ticket);
      return actor;
    },
    end(actor) {
      const who = `${actor.kind}:${actor.id}`;
      for (const ticket of theirs.get(who) ?? []) issued.delete(ticket);
      theirs.delete(who);
    },
    close() {
      issued.close();
      counted.close();
      theirs.close();
    },
  };
}
