/**
 * A web line's budget for the day (UTC), kept with its counters, in memory:
 * what its visitors' model use was charged (`spent`, as the usage ledger
 * prices it), and what's held for messages let in whose turns haven't been
 * charged yet (`holds`, each a visitor's).
 *
 * - **Sending** holds an estimate first (`hold`): the most one of its
 *   visitors' model calls cost here lately; before any is known, the rest of
 *   the day's budget (so one turn goes at a time until a cost is known). One
 *   that doesn't fit beside what's spent and held is refused: messages sent
 *   at once can't all pass a budget only one fits.
 * - **A priced call** is charged (`charge`), and the visitor's hold goes
 *   with it. A hold not charged in two minutes lapses (its turn failed).
 * - **Before each call** (`left`), a visitor's turn goes on only while the
 *   day isn't spent: a tool loop stops there.
 * - **Use nothing prices** (a model the ledger has no price for) closes the
 *   line for the day (`close`): a budget that can't be counted holds nothing.
 *
 * Each change is one write that applies only to the day as it was read (its
 * `v`), tried again when another came between.
 */
import { type Collection, failure } from "../../../../runtime/mod.ts";
import type { Rate } from "../collections/rate.ts";

const DAY = 86_400_000;
/** How long a message's hold lasts without being charged. */
export const HOLD_MS = 120_000;
/** How long what one call cost is remembered, as the estimate. */
const REMEMBERED = 30 * DAY;
/** How long (ms) a change keeps trying while others change the day too. */
const PATIENCE = 3_000;

/** The web lines' counters (`contact_rate`), as the system reaches them. */
type Rates = Collection<Rate & Day>;

/** The day's budget, as kept. */
export type Day = {
  spent?: number;
  holds?: Record<string, { amount: number; until: number }>;
  /** Why the day is closed (use nothing priced: its model). */
  closed?: string;
  v?: number;
};

/** What visitors are told when the budget refuses. */
export const BUDGET = {
  spent: "This chat has done all it can for today: come back tomorrow.",
  held: "This chat is busy right now: try again in a moment.",
} as const;

const dayOf = (line: string, now: number) => `${line}|spent@${Math.floor(now / DAY) * DAY}`;
const costOf = (line: string) => `${line}|cost`;

/** What's held now: holds not yet lapsed. */
const heldOf = (day: Day | null, now: number) =>
  Object.fromEntries(Object.entries(day?.holds ?? {}).filter(([, h]) => h.until > now));

const sum = (holds: Day["holds"]) =>
  Object.values(holds ?? {}).reduce((total, h) => total + h.amount, 0);

/**
 * Changes the day as `change` says from what it was: one write, applying
 * only if nothing came between (else read again, with jitter, until `PATIENCE` runs out).
 */
async function changeDay(
  rates: Rates,
  line: string,
  now: number,
  change: (day: Day | null) => Partial<Day> | undefined,
): Promise<void> {
  const _id = dayOf(line, now);
  const deadline = performance.now() + PATIENCE;
  for (let tries = 0; performance.now() < deadline; tries++) {
    // Another came between: read again after a moment, apart from the others by chance.
    if (tries) await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * tries, 50)));
    const day = await rates.findOne({ _id });
    const next = change(day);
    if (!next) return;
    const v = day?.v ?? 0;
    try {
      const done = await rates.updateOne(
        day ? { _id, v } : { _id, v: { $exists: false } },
        { $set: { ...next, v: v + 1, until: Math.floor(now / DAY) * DAY + DAY } },
        { upsert: !day },
      );
      if (!day || done.matchedCount > 0) return;
    } catch (error) {
      // Made meanwhile by another: read it again.
      if ((error as { code?: string }).code !== "duplicate_key") throw error;
    }
  }
  throw failure("too_many", BUDGET.held, { public: true });
}

/**
 * Holds an estimate of a visitor's message's cost against the day's budget,
 * or refuses it (`too_many`, said to anyone): spent, or what's held already
 * leaves no room.
 */
export async function hold(
  rates: Rates,
  line: { name: string; budget: number },
  contact: string,
  now = Date.now(),
): Promise<void> {
  const known = (await rates.findOne({ _id: costOf(line.name) }))?.spent;
  await changeDay(rates, line.name, now, (day) => {
    if (day?.closed || (day?.spent ?? 0) >= line.budget) {
      throw failure("too_many", BUDGET.spent, { public: true });
    }
    const holds = heldOf(day, now);
    const rest = line.budget - (day?.spent ?? 0) - sum(holds);
    // Nothing known yet: the rest of the day's, so one at a time until a cost is.
    // A call known to cost more than the whole budget holds what's left: it runs, and is charged.
    // (With other holds in place, it must fit beside them.)
    const alone = !Object.keys(holds).length;
    const estimate = known === undefined ? rest : alone ? Math.min(known, rest) : known;
    if (known === undefined ? rest <= 0 : estimate > rest) {
      throw failure("too_many", BUDGET.held, { public: true });
    }
    const mine = holds[contact]?.amount ?? 0;
    return { holds: { ...holds, [contact]: { amount: mine + estimate, until: now + HOLD_MS } } };
  });
}

/** A visitor's priced model call: charged to the day, its hold gone with it; remembered as the estimate. */
export async function charge(
  rates: Rates,
  line: string,
  contact: string | undefined,
  price: number,
  now = Date.now(),
): Promise<void> {
  // One atomic write: nothing read first, so charges at once can't overwrite each other.
  const _id = dayOf(line, now);
  const until = Math.floor(now / DAY) * DAY + DAY;
  const change = {
    $inc: { spent: price, v: 1 },
    $set: { until },
    ...(contact ? { $unset: { [`holds.${contact}`]: "" } } : {}),
  };
  try {
    await rates.updateOne({ _id }, change as never, { upsert: true });
  } catch (error) {
    // Made meanwhile by another (an upsert race): this one applies to it.
    if ((error as { code?: string }).code !== "duplicate_key") throw error;
    await rates.updateOne({ _id }, change as never);
  }
  // The most one call cost lately, coming down slowly: what the next message holds.
  const cost = await rates.findOne({ _id: costOf(line) });
  const was = cost?.spent ?? 0;
  await rates.updateOne(
    { _id: costOf(line) },
    { $set: { spent: Math.max(price, was * 0.9), until: now + REMEMBERED } },
    { upsert: true },
  );
}

/**
 * Use nothing prices: the day is closed, its visitors' messages refused
 * until tomorrow. Whether this closed it (it wasn't already).
 */
export async function close(
  rates: Rates,
  line: string,
  why: string,
  now = Date.now(),
): Promise<boolean> {
  let closed = false;
  await changeDay(rates, line, now, (day) => {
    closed = !day?.closed;
    return closed ? { closed: why } : undefined;
  });
  return closed;
}

/** Whether a visitor's turn may make another call: not once the day is spent, or closed. */
export async function left(
  rates: Rates,
  line: { name: string; budget: number },
  now = Date.now(),
): Promise<boolean> {
  const day = await rates.findOne({ _id: dayOf(line.name, now) });
  return !day?.closed && (day?.spent ?? 0) < line.budget;
}
