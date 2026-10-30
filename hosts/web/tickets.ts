/**
 * Tickets: what a signed-in browser trades its session for, to connect. The
 * session stays in an httpOnly cookie its code never sees; a ticket works
 * once, for a minute, and the runtime's `admit` turns it into the person.
 *
 * ```ts
 * const tickets = createTickets();
 * const runtime = await createRuntime({ store, plugins, admit: tickets.admit });
 * ```
 */
import type { Actor } from "../../runtime/mod.ts";

export type Tickets = {
  /** A ticket for this person, for one connection. */
  issue(actor: Actor): string;
  /** Who a ticket is for, once; undefined when it's unknown, used or old. */
  admit(ticket: string): Actor | undefined;
};

export function createTickets(options: { ms?: number } = {}): Tickets {
  const ms = options.ms ?? 60_000;
  const issued = new Map<string, { actor: Actor; until: number }>();
  return {
    issue(actor) {
      const now = Date.now();
      for (const [ticket, kept] of issued) if (kept.until < now) issued.delete(ticket);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      issued.set(ticket, { actor, until: now + ms });
      return ticket;
    },
    admit(ticket) {
      const kept = issued.get(ticket);
      issued.delete(ticket);
      return kept && kept.until > Date.now() ? kept.actor : undefined;
    },
  };
}
