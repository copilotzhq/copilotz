/** `usage.rerate`: brings records' cost and price to the books in force now, with adjustments. */
import { type Context, defineAction, type Filter } from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { type Parts, type Quantities, rate, round } from "../shared/rate.ts";
import { priceOf } from "../shared/use.ts";

/** Appends adjustments that bring records' cost and price to what the books say now. */
async function rerate(ctx: Context, filter: Filter) {
  const records = await ctx.db.collection<UsageRecord>("usage").find(filter);
  // What each use comes to now: its rating and its adjustments', by part too.
  type Net = { cost: number; price: number; costs: Parts; prices: Parts };
  const net = new Map<string, Net>();
  const add = (into: Parts, parts: Parts | undefined, sign = 1) => {
    for (const [unit, usd] of Object.entries(parts ?? {})) {
      into[unit] = (into[unit] ?? 0) + sign * usd;
    }
  };
  for (const record of records) {
    const id = record.adjusts ?? record._id;
    const sum = net.get(id) ?? { cost: 0, price: 0, costs: {}, prices: {} };
    sum.cost += record.cost ?? 0;
    sum.price += priceOf(record) ?? 0;
    add(sum.costs, record.costs);
    add(sum.prices, record.prices);
    net.set(id, sum);
  }
  let adjusted = 0;
  for (const record of records) {
    if (record.adjusts) continue;
    const now = await rate(ctx, {
      meter: record.meter,
      subject: record.subject,
      catalog: record.catalog,
      quantities: record.quantities as Quantities,
      at: record.at,
    });
    const was = net.get(record._id)!;
    const cost = round((now.cost ?? 0) - was.cost);
    const price = round((now.price ?? 0) - was.price);
    if (!cost && !price) continue;
    const delta = (to: Parts | undefined, from: Parts) => {
      const out: Parts = {};
      add(out, to);
      add(out, from, -1);
      return Object.fromEntries(
        Object.entries(out).map(([u, usd]) => [u, round(usd)]).filter(([, usd]) => usd !== 0),
      );
    };
    const costs = delta(now.costs, was.costs);
    const prices = delta(now.prices, was.prices);
    ctx.record("usage", {
      meter: record.meter,
      subject: record.subject,
      quantities: {},
      ...(record.tags ? { tags: record.tags } : {}),
      cost,
      price,
      ...(Object.keys(costs).length ? { costs } : {}),
      ...(Object.keys(prices).length ? { prices } : {}),
      rated: now.rated,
      adjusts: record._id,
      kind: "adjustment",
      at: new Date().toISOString(),
    });
    adjusted++;
  }
  return { adjusted };
}

export const rerateAction = defineAction({
  input: { type: "object", properties: { filter: { type: "object" } } },
  run: (ctx, input) => rerate(ctx, (input.filter ?? {}) as Filter),
});
