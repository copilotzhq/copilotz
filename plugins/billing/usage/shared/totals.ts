/**
 * Totals of records, grouped by fields: `meter`, `subject`, `day`, `month`,
 * `tags.<name>`, or any other. The store sums them (`aggregate`): only the
 * groups come back, however many records there are.
 *
 * With rollups (see actions/close.ts), the whole closed days a query covers
 * come from them: each day's few groups instead of its records. The rest
 * (open days, and the part of a day a time filter cuts) comes from the
 * records. The totals are the same either way; rollups make them cheaper.
 */
import type {
  Accumulator,
  Expr,
  Filter,
  ReadCollection,
  ReadContext,
  Stage,
} from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import type { ClosedDay } from "../collections/closed.ts";
import { addDays, firstWholeDay, lastWholeDay } from "./days.ts";
import { type Quantities, round } from "./rate.ts";

/** What uses are measured in, unless a query names its own. */
export const UNITS = ["input", "output", "cached", "cacheWrite", "reasoning", "seconds", "calls"];

export type Totals = {
  /** The values grouped by. */
  key: Record<string, unknown>;
  quantities: Quantities;
  cost: number;
  price: number;
  /** Uses counted (adjustments aren't uses). */
  uses: number;
  /** Uses with no cost or price. */
  unpriced: number;
};

/** How usage is rolled up by day. */
export type Rollups = {
  /** Record fields grouped by besides meter and subject: `tags.<name>` or `catalog`. */
  dimensions: string[];
  /** Quantities summed. */
  units: string[];
  /** Closed days counted again at each close, for records that came late. */
  recheck: number;
};

type Group = Record<string, unknown> & { _id: Record<string, unknown> };

/** A field to group records by: `day` and `month` cut the time. */
const ofRecords = (field: string): Expr =>
  field === "day"
    ? { $substr: ["$at", 0, 10] }
    : field === "month"
    ? { $substr: ["$at", 0, 7] }
    : `$${field}`;

/** The same field in rollups, which name their day. */
const ofRollups = (field: string): Expr =>
  field === "day" ? "$day" : field === "month" ? { $substr: ["$day", 0, 7] } : `$${field}`;

/**
 * Sums what `filter` matches, grouped by `key`, and also by whether it's a
 * use or an adjustment and what it left unpriced (few kinds of each), so
 * `fold` can count uses. Records and rollups are summed alike; `count` is
 * how a group counts what it holds.
 */
export const summing = (
  filter: Filter,
  key: Record<string, Expr>,
  units: string[],
  count: Accumulator,
): Stage[] => [
  { $match: filter },
  {
    $group: {
      _id: { ...key, _kind: "$kind", _unpriced: "$unpriced" },
      ...Object.fromEntries(units.map((unit) => [unit, { $sum: `$quantities.${unit}` }])),
      cost: { $sum: "$cost" },
      price: { $sum: "$price" },
      n: count,
    },
  },
];

/** Groups (from records, rollups or both) folded into totals by their key. */
function fold(groups: Group[], units: string[]): Totals[] {
  const out = new Map<string, Totals>();
  for (const group of groups) {
    const { _kind, _unpriced, ...key } = group._id;
    const id = JSON.stringify(key);
    const sum = out.get(id) ??
      { key, quantities: {}, cost: 0, price: 0, uses: 0, unpriced: 0 } as Totals;
    for (const unit of units) {
      const n = Number(group[unit] ?? 0);
      if (n) sum.quantities[unit] = round((sum.quantities[unit] ?? 0) + n);
    }
    sum.cost = round(sum.cost + Number(group.cost ?? 0));
    sum.price = round(sum.price + Number(group.price ?? 0));
    if (_kind !== "adjustment") {
      sum.uses += Number(group.n);
      if (Array.isArray(_unpriced) && _unpriced.length) sum.unpriced += Number(group.n);
    }
    out.set(id, sum);
  }
  return [...out.values()];
}

type Bounds = { $gte?: string; $gt?: string; $lt?: string; $lte?: string };

/** A time filter rollups can serve: only bounds, each a string. */
const bounds = (at: unknown): Bounds | undefined =>
  at === undefined ? {} : at && typeof at === "object" && !Array.isArray(at) &&
      Object.entries(at).every(([op, v]) =>
        ["$gte", "$gt", "$lt", "$lte"].includes(op) && typeof v === "string"
      )
    ? at as Bounds
    : undefined;

/**
 * The closed days a query can take from rollups: whole days within its time
 * bounds, when everything it filters and groups by is in them.
 */
async function rolled(
  db: ReadContext["db"],
  rollups: Rollups,
  filter: Filter,
  by: string[],
  units: string[],
): Promise<{ from: string; through: string } | undefined> {
  const fields = new Set(["meter", "subject", "kind", ...rollups.dimensions]);
  if (!by.every((field) => field === "day" || field === "month" || fields.has(field))) return;
  if (!units.every((unit) => rollups.units.includes(unit))) return;
  if (!Object.keys(filter).every((key) => key === "at" || fields.has(key))) return;
  const at = bounds(filter.at);
  if (!at) return;
  const closed = db.collection<ClosedDay>("usageClosed");
  const [first, last] = await Promise.all([
    closed.findOne({}, { sort: { _id: 1 } }),
    closed.findOne({}, { sort: { _id: -1 } }),
  ]);
  if (!first || !last) return;
  let from = first._id;
  let through = last._id;
  for (const bound of [at.$gte, at.$gt]) {
    if (bound === undefined) continue;
    const day = firstWholeDay(bound);
    if (!day) return;
    if (day > from) from = day;
  }
  for (const bound of [at.$lt, at.$lte]) {
    if (bound === undefined) continue;
    const day = lastWholeDay(bound);
    if (!day) return;
    if (day < through) through = day;
  }
  return from <= through ? { from, through } : undefined;
}

export async function totals(
  records: ReadCollection<UsageRecord>,
  params: { filter?: Filter; by?: string[]; units?: string[] } = {},
  rollups?: { db: ReadContext["db"]; rollups: Rollups },
): Promise<Totals[]> {
  const filter = params.filter ?? {};
  const by = params.by ?? [];
  const units = params.units ?? UNITS;
  const raw = (f: Filter) =>
    records.aggregate<Group>(
      summing(f, Object.fromEntries(by.map((x) => [x, ofRecords(x)])), units, { $count: {} }),
    );
  const span = rollups && await rolled(rollups.db, rollups.rollups, filter, by, units);
  if (!span) return fold(await raw(filter), units);
  // Records before the closed days and after them, and the closed days' rollups between.
  const { at, ...rest } = filter as Filter & { at?: Bounds };
  const lower = { ...(at?.$gte ? { $gte: at.$gte } : {}), ...(at?.$gt ? { $gt: at.$gt } : {}) };
  const upper = { ...(at?.$lt ? { $lt: at.$lt } : {}), ...(at?.$lte ? { $lte: at.$lte } : {}) };
  // An edge the bounds leave nothing in isn't read: bounds on whole days leave neither.
  const next = addDays(span.through, 1);
  const before = !(at?.$gte !== undefined && at.$gte >= span.from) &&
    !(at?.$gt !== undefined && at.$gt >= span.from);
  const after = !(at?.$lt !== undefined && at.$lt <= next) &&
    !(at?.$lte !== undefined && at.$lte < next);
  const parts = await Promise.all([
    before ? raw({ ...rest, at: { ...lower, $lt: span.from } }) : [],
    rollups.db.collection("usageRollup").aggregate<Group>(
      summing(
        { ...rest, day: { $gte: span.from, $lte: span.through } },
        Object.fromEntries(by.map((x) => [x, ofRollups(x)])),
        units,
        { $sum: "$n" },
      ),
    ),
    after ? raw({ ...rest, at: { ...upper, $gte: next } }) : [],
  ]);
  return fold(parts.flat(), units);
}
