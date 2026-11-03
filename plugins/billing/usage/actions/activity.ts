/**
 * `usage.activity` `{ filter?, limit? }`: what was done, newest first, as
 * people recognize it rather than as the ledger keeps it, each with what it
 * was charged (and, for staff, what it cost). Filtered as totals are
 * (`category`, `tags.space`…); everyone's for those who run the org, else
 * the caller's own (see org.ts). Each item is one of:
 *
 * - `turn`: an agent's turn, the records sharing `tags.turn`: its agent,
 *   conversation, space and person, its main model (the one charged most),
 *   and its model calls (`calls`), oldest first;
 * - `model`: model calls outside a turn, by day: a conversation's upkeep
 *   (its summaries, memory notes, a voice message transcribed: `purposes`),
 *   one a day; else by agent or purpose and person (drafting an agent, or
 *   an agent's calls from before turns were recorded);
 * - `session`: a computer awake, from one wake to its release (its records
 *   share `tags.session`), with how long;
 * - `computer`: a computer's day, for what has no session: its disk or
 *   snapshot's storage, and minutes metered before sessions were recorded;
 * - `app`: an app's day: its builds, what it ran, its requests;
 * - `other`: any other meter's, by subject and day.
 *
 * `names`: the conversations, spaces, computers and apps they name, as the
 * caller reaches them. `more`: there are older ones (ask for more).
 */
import { type Context, defineAction, type Filter, people } from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { byMeters, type Categories } from "../shared/categories.ts";
import { named } from "../shared/names.ts";
import { type Quantities, round } from "../shared/rate.ts";
import { categoriesOf } from "../shared/settings.ts";
import { priceOf } from "../shared/use.ts";
import { sight } from "./org.ts";

export type ActivityKind = "turn" | "model" | "session" | "computer" | "app" | "other";

/** A model call in a turn. */
export type ActivityCall = {
  _id: string;
  meter: string;
  subject: string;
  quantities: Quantities;
  price?: number;
  cost?: number;
  saved?: { price?: number; cost?: number };
  unpriced?: string[];
  paid?: string;
  at: string;
};

export type ActivityItem = {
  kind: ActivityKind;
  /** Stable among the answers: the turn, or what it was grouped by. */
  id: string;
  /** Its first record's time and its last's. */
  first: string;
  last: string;
  /** What it was charged; staff: what it cost too. */
  price: number;
  cost?: number;
  saved: { price: number; cost?: number };
  quantities: Quantities;
  /** Records counted, and how many of them nothing priced. */
  uses: number;
  unpriced: number;
  /** What it was for: thread, agent, space, person, purpose, computer, session, app, paid… */
  tags: Record<string, string>;
  /** A conversation's upkeep: what it was for (`history`, `memory`…). */
  purposes?: string[];
  /** A turn's main model; a session's or a day's subject (a computer's size, its disk). */
  subject?: string;
  meter?: string;
  calls?: ActivityCall[];
};

/** Summed for every item: tokens, computers' and apps' units. */
const UNITS = [
  "input",
  "output",
  "cached",
  "cacheWrite",
  "reasoning",
  "seconds",
  "minutes",
  "calls",
  "requests",
  "vcpuSeconds",
  "gibSeconds",
  "gbHours",
];

/** A turn's calls read at most, in all. */
const MAX_CALLS = 2_000;

type Group = Record<string, unknown> & { _id: Record<string, unknown> };

const day = { $substr: ["$at", 0, 10] } as const;

/**
 * Sums of what `match` holds by `key`, and by who rated the price and what
 * went unpriced (as totals sum them), so a record from before every use had
 * a price is priced at its cost.
 */
const pipeline = (match: Filter, key: Record<string, unknown>) => [
  { $match: match },
  {
    $group: {
      _id: { ...key, _rated: "$rated.price", _unpriced: "$unpriced" },
      first: { $min: "$at" },
      last: { $max: "$at" },
      cost: { $sum: "$cost" },
      price: { $sum: "$price" },
      savedCost: { $sum: "$saved.cost" },
      savedPrice: { $sum: "$saved.price" },
      n: { $count: {} },
      ...Object.fromEntries(UNITS.map((unit) => [unit, { $sum: `$quantities.${unit}` }])),
    },
  },
];

/** Groups folded into items by their key (their rating apart), each of `kind`. */
function fold(kind: ActivityKind, groups: Group[]): ActivityItem[] {
  const out = new Map<string, ActivityItem>();
  for (const group of groups) {
    const { _rated, _unpriced, ...key } = group._id;
    const id = `${kind}:${JSON.stringify(key)}`;
    const tags = Object.fromEntries(
      Object.entries(key).filter(([name, v]) =>
        typeof v === "string" && !["day", "subject", "meter"].includes(name)
      ),
    ) as Record<string, string>;
    const item = out.get(id) ?? {
      kind,
      id,
      first: group.first as string,
      last: group.last as string,
      price: 0,
      saved: { price: 0, cost: 0 },
      quantities: {},
      uses: 0,
      unpriced: 0,
      tags,
      ...(typeof key.subject === "string" ? { subject: key.subject } : {}),
      ...(typeof key.meter === "string" ? { meter: key.meter } : {}),
      cost: 0,
    };
    const cost = Number(group.cost ?? 0);
    item.cost = round(item.cost! + cost);
    item.price = round(
      item.price + Number(group.price ?? 0) + (_rated === null || _rated === undefined ? cost : 0),
    );
    item.saved.price = round(item.saved.price + Number(group.savedPrice ?? 0));
    item.saved.cost = round(item.saved.cost! + Number(group.savedCost ?? 0));
    for (const unit of UNITS) {
      const n = Number(group[unit] ?? 0);
      if (n) item.quantities[unit] = round((item.quantities[unit] ?? 0) + n);
    }
    item.uses += Number(group.n);
    if (Array.isArray(_unpriced) && _unpriced.length) item.unpriced += Number(group.n);
    if ((group.first as string) < item.first) item.first = group.first as string;
    if ((group.last as string) > item.last) item.last = group.last as string;
    out.set(id, item);
  }
  return [...out.values()];
}

/**
 * A conversation's upkeep, one item a day: its purposes and people (grouped
 * apart) folded together, saying what it was for (`purposes`).
 */
function upkeep(items: ActivityItem[]): ActivityItem[] {
  const out = new Map<string, ActivityItem>();
  for (const item of items) {
    const t = item.tags;
    if (item.kind !== "model" || t.agent || !t.thread) {
      out.set(item.id, item);
      continue;
    }
    const key = `model:${JSON.stringify([t.thread, t.space, t.paid, item.first.slice(0, 10)])}`;
    const had = out.get(key);
    const purposes = t.purpose ? [t.purpose] : [];
    if (!had) {
      const { purpose: _purpose, person, ...tags } = t;
      out.set(key, {
        ...item,
        id: key,
        tags: { ...tags, ...(person ? { person } : {}) },
        purposes,
      });
      continue;
    }
    if (had.tags.person !== t.person) delete had.tags.person;
    had.purposes = [...new Set([...had.purposes ?? [], ...purposes])].sort();
    had.price = round(had.price + item.price);
    if (had.cost !== undefined) had.cost = round(had.cost + (item.cost ?? 0));
    had.saved.price = round(had.saved.price + item.saved.price);
    if (had.saved.cost !== undefined) {
      had.saved.cost = round(had.saved.cost + (item.saved.cost ?? 0));
    }
    for (const [unit, n] of Object.entries(item.quantities)) {
      had.quantities[unit] = round((had.quantities[unit] ?? 0) + (n ?? 0));
    }
    had.uses += item.uses;
    had.unpriced += item.unpriced;
    if (item.first < had.first) had.first = item.first;
    if (item.last > had.last) had.last = item.last;
  }
  return [...out.values()];
}

/** A turn's calls, its main model (the one charged most, else most used) and whose it was. */
function filled(item: ActivityItem, calls: UsageRecord[], costs: boolean): ActivityItem {
  const by = new Map<string, number>();
  for (const call of calls) {
    by.set(
      call.subject,
      (by.get(call.subject) ?? 0) + (priceOf(call) ?? 0) * 1e9 +
        (call.quantities.input ?? 0) + (call.quantities.output ?? 0),
    );
  }
  const main = [...by].sort((a, b) => b[1] - a[1])[0]?.[0];
  const tags = calls.find((c) => c.tags)?.tags ?? {};
  const paid = calls.every((c) => c.tags?.paid && c.tags.paid === calls[0].tags?.paid)
    ? calls[0]?.tags?.paid
    : undefined;
  return {
    ...item,
    ...(main ? { subject: main } : {}),
    tags: {
      ...Object.fromEntries(
        ["thread", "agent", "space", "person"].flatMap((name) =>
          tags[name] ? [[name, tags[name]]] : []
        ),
      ),
      ...item.tags,
      ...(paid ? { paid } : {}),
    },
    calls: calls.map((r) => {
      const price = priceOf(r);
      const saved = r.saved && (costs ? r.saved : { price: r.saved.price });
      return {
        _id: r._id,
        meter: r.meter,
        subject: r.subject,
        quantities: r.quantities,
        ...(price !== undefined ? { price } : {}),
        ...(costs && r.cost !== undefined ? { cost: r.cost } : {}),
        ...(saved && Object.values(saved).some((v) => v !== undefined) ? { saved } : {}),
        ...(r.unpriced?.length ? { unpriced: r.unpriced } : {}),
        ...(r.tags?.paid ? { paid: r.tags.paid } : {}),
        at: r.at,
      };
    }),
  };
}

/** What each kind of item is grouped by, and what it holds. */
function kinds(base: Filter, categories: Categories) {
  const agents = categories.agents ?? [];
  const computers = categories.computers ?? [];
  const apps = categories.apps ?? [];
  const meter = (meters: string[]) => ({ meter: { $in: meters } });
  const and = (...parts: Filter[]): Filter => ({ $and: [base, ...parts] });
  return {
    turn: [and({ "tags.turn": { $exists: true } }), { turn: "$tags.turn" }],
    model: [
      and(meter(agents), { "tags.turn": { $exists: false } }),
      {
        thread: "$tags.thread",
        agent: "$tags.agent",
        purpose: "$tags.purpose",
        space: "$tags.space",
        person: "$tags.person",
        paid: "$tags.paid",
        day,
      },
    ],
    session: [
      and(meter(computers), { "tags.session": { $exists: true } }),
      {
        computer: "$tags.computer",
        session: "$tags.session",
        subject: "$subject",
        space: "$tags.space",
        person: "$tags.person",
      },
    ],
    computer: [
      and(meter(computers), { "tags.session": { $exists: false } }),
      {
        computer: "$tags.computer",
        subject: "$subject",
        space: "$tags.space",
        person: "$tags.person",
        day,
      },
    ],
    app: [and(meter(apps)), {
      app: "$tags.app",
      space: "$tags.space",
      person: "$tags.person",
      day,
    }],
    other: [
      and({ meter: { $nin: [...agents, ...computers, ...apps] } }),
      { meter: "$meter", subject: "$subject", person: "$tags.person", day },
    ],
  } as Record<ActivityKind, [Filter, Record<string, unknown>]>;
}

export async function activity(
  ctx: Context,
  input: { filter?: Filter; limit?: number },
): Promise<{
  items: ActivityItem[];
  more: boolean;
  names: Record<string, Record<string, { name: string; owner?: string }>>;
  all: boolean;
  costs: boolean;
}> {
  const { all, costs, mine } = await sight(ctx);
  const limit = input.limit ?? 30;
  const categories = categoriesOf(ctx);
  // Uses only (adjustments correct a rating; they aren't things done); yours unless you run it.
  const base: Filter = {
    ...byMeters(input.filter ?? {}, categories),
    kind: { $exists: false },
    ...mine,
  };
  // The ledger is read as the system, within what the caller sees.
  const usage = ctx.as().db.collection<UsageRecord>("usage");
  const found = upkeep(
    (await Promise.all(
      Object.entries(kinds(base, categories)).map(async ([kind, [match, key]]) =>
        fold(kind as ActivityKind, await usage.aggregate<Group>(pipeline(match, key)))
      ),
    )).flat(),
  ).sort((a, b) => a.last < b.last ? 1 : a.last > b.last ? -1 : 0);
  const shown = found.slice(0, limit);

  // The turns' calls, filtered as they were found.
  const turns = shown.filter((item) => item.kind === "turn").map((item) => item.tags.turn);
  const calls = turns.length
    ? await usage.find({ $and: [base, { "tags.turn": { $in: turns } }] }, {
      sort: { at: 1 },
      limit: MAX_CALLS,
    })
    : [];
  const byTurn = new Map<string, UsageRecord[]>();
  for (const call of calls) {
    const turn = call.tags?.turn ?? "";
    byTurn.set(turn, [...byTurn.get(turn) ?? [], call]);
  }
  const items = shown.map((item) => {
    const done = item.kind === "turn"
      ? filled(item, byTurn.get(item.tags.turn) ?? [], costs)
      : item;
    if (costs) return done;
    const { cost: _cost, saved, ...rest } = done;
    return { ...rest, saved: { price: saved.price } };
  });

  const names = await named(ctx, {
    "tags.thread": items.map((item) => item.tags.thread),
    "tags.space": items.map((item) => item.tags.space),
    "tags.computer": items.map((item) => item.tags.computer),
    "tags.app": items.map((item) => item.tags.app),
  });
  return { items, more: found.length > limit, names, all, costs };
}

export const activityAction = defineAction({
  description:
    "What was done, newest first (agents' turns, computers' sessions, apps' days), with what " +
    "each was charged: everyone's for the org's owners and admins, your own for others",
  record: false,
  input: {
    type: "object",
    properties: {
      filter: { type: "object" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  allow: people,
  run: (ctx, input) => activity(ctx, input as { filter?: Filter; limit?: number }),
});
