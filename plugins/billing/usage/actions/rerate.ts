/** `usage.rerate`: brings records' cost and price to the books in force now, with adjustments. */
import { type Context, defineAction, type Filter } from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { type Quantities, rate, round } from "../shared/rate.ts";

/** Appends adjustments that bring records' cost and price to what the books say now. */
async function rerate(ctx: Context, filter: Filter) {
  const records = await ctx.db.collection<UsageRecord>("usage").find(filter);
  const net = new Map<string, { cost: number; price: number }>();
  for (const record of records) {
    const id = record.adjusts ?? record._id;
    const sum = net.get(id) ?? { cost: 0, price: 0 };
    net.set(id, { cost: sum.cost + (record.cost ?? 0), price: sum.price + (record.price ?? 0) });
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
    ctx.record("usage", {
      meter: record.meter,
      subject: record.subject,
      quantities: {},
      ...(record.tags ? { tags: record.tags } : {}),
      cost,
      price,
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
