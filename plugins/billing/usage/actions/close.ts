/**
 * `usage.close`: rolls up whole days of the ledger, so totals over them read
 * a day's groups instead of its records. A declared schedule calls it each
 * day (00:10 UTC); it closes every day not yet closed through the day before
 * the one it was called for (or `through`).
 *
 * The ledger only grows, so a closed day's record count tells whether
 * records came late: each close counts the last `recheck` closed days again
 * (one indexed pass) and closes again from the first that changed. `from`
 * closes again from a day on, for records older than that.
 */
import { type Context, defineAction, type Doc, type Expr } from "../../../../runtime/mod.ts";
import type { ClosedDay } from "../collections/closed.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { addDays, DAY, dayOf } from "../shared/days.ts";
import { rollupsOf } from "../shared/settings.ts";
import { type Rollups, summing } from "../shared/totals.ts";

/** Days aggregated in one pass, and rollups written in one transaction (whole days each). */
const WINDOW_DAYS = 31;
const BATCH_ROLLUPS = 5_000;

type Group = Record<string, unknown> & { _id: Record<string, unknown> };

/** Sets a dot path's value in a document. */
function put(doc: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    target = (target[key] ??= {}) as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
}

/** The first day to close: after the last closed, or from the first that changed since. */
async function start(ctx: Context, rollups: Rollups): Promise<string | undefined> {
  const usage = ctx.db.collection<UsageRecord>("usage");
  const closed = ctx.db.collection<ClosedDay>("usageClosed");
  const last = await closed.findOne({}, { sort: { _id: -1 } });
  if (!last) {
    const first = await usage.findOne({}, { sort: { at: 1 } });
    return first ? dayOf(first.at) : undefined;
  }
  const since = addDays(last._id, 1 - rollups.recheck);
  const [counts, kept] = await Promise.all([
    usage.aggregate<{ _id: string; n: number }>([
      { $match: { at: { $gte: since, $lt: addDays(last._id, 1) } } },
      { $group: { _id: { $substr: ["$at", 0, 10] }, n: { $count: {} } } },
    ]),
    closed.find({ _id: { $gte: since } }),
  ]);
  const had = new Map(kept.map((day) => [day._id, day.records]));
  const changed = counts.filter((day) => had.get(day._id) !== day.n).map((day) => day._id).sort();
  return changed[0] ?? addDays(last._id, 1);
}

async function close(
  ctx: Context,
  rollups: Rollups,
  input: { from?: string; through?: string },
): Promise<{ from?: string; through?: string; days: number; rollups: number }> {
  // Through the day before the one time called for (or today, called by anyone else).
  const through = input.through ??
    addDays(dayOf(ctx.scheduled?.at ?? new Date().toISOString()), -1);
  const from = input.from ?? await start(ctx, rollups);
  if (!from || from > through) return { days: 0, rollups: 0 };
  const key: Record<string, Expr> = {
    day: { $substr: ["$at", 0, 10] },
    meter: "$meter",
    subject: "$subject",
    ...Object.fromEntries(rollups.dimensions.map((d, i) => [`d${i}`, `$${d}`])),
  };
  const now = new Date().toISOString();
  let days = 0;
  let written = 0;
  for (let window = from; window <= through; window = addDays(window, WINDOW_DAYS)) {
    const end = [addDays(window, WINDOW_DAYS - 1), through].sort()[0];
    const groups = await ctx.db.collection("usage").aggregate<Group>(
      summing({ at: { $gte: window, $lt: addDays(end, 1) } }, key, rollups.units, { $count: {} }),
    );
    // Each day's rollups, as the records hold their fields.
    const byDay = new Map<string, Doc[]>();
    for (const group of groups) {
      const { day, meter, subject, _kind, _unpriced, ...dims } = group._id;
      const doc: Doc = { _id: "", day, meter, subject, quantities: {}, n: group.n };
      rollups.dimensions.forEach((d, i) => {
        if (dims[`d${i}`] !== null && dims[`d${i}`] !== undefined) put(doc, d, dims[`d${i}`]);
      });
      if (_kind !== null) doc.kind = _kind;
      if (_unpriced !== null) doc.unpriced = _unpriced;
      for (const unit of rollups.units) {
        if (group[unit]) (doc.quantities as Record<string, number>)[unit] = group[unit] as number;
      }
      if (group.cost) doc.cost = group.cost;
      if (group.price) doc.price = group.price;
      const list = byDay.get(day as string) ?? [];
      doc._id = `${day}#${list.length}`;
      list.push(doc);
      byDay.set(day as string, list);
    }
    // Whole days at a time: a closed day always has all its rollups.
    let batch: string[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const [first, last] = [batch[0], batch.at(-1)!];
      const docs = batch.flatMap((day) => byDay.get(day) ?? []);
      await ctx.transaction(async (tx) => {
        const rollup = tx.db.collection("usageRollup");
        await rollup.deleteMany({ day: { $gte: first, $lte: last } }, { writeConcern: { w: 0 } });
        if (docs.length) await rollup.insertMany(docs);
        for (const day of batch) {
          const made = byDay.get(day) ?? [];
          await tx.db.collection("usageClosed").replaceOne(
            { _id: day },
            {
              records: made.reduce((n, doc) => n + (doc.n as number), 0),
              groups: made.length,
              at: now,
            },
            { upsert: true, writeConcern: { w: 0 } },
          );
        }
      });
      days += batch.length;
      written += docs.length;
      batch = [];
      size = 0;
    };
    for (let day = window; day <= end; day = addDays(day, 1)) {
      batch.push(day);
      size += byDay.get(day)?.length ?? 0;
      if (size >= BATCH_ROLLUPS) await flush();
    }
    await flush();
  }
  return { from, through, days, rollups: written };
}

export const closeAction = defineAction({
  input: {
    type: "object",
    properties: {
      from: { type: "string", pattern: DAY },
      through: { type: "string", pattern: DAY },
    },
    additionalProperties: false,
  },
  run: (ctx, input) => close(ctx, rollupsOf(ctx), input),
});
