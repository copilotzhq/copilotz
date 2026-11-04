/**
 * `contact.spent` `{ line, price }`: what one of a web line's visitors'
 * model calls was charged, counted against the line's budget for the day
 * (UTC), in memory. Its listener on the models plugin's `modelUse` calls it
 * (resources/spend.ts); nobody outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Rate } from "../collections/rate.ts";

const DAY = 86_400_000;

/** A write whose answer isn't needed. */
const UNANSWERED = { writeConcern: { w: 0 } } as const;

export const spentAction = defineAction({
  description: "Counts what a web line's visitors' model call was charged, against its budget",
  record: false,
  input: {
    type: "object",
    properties: {
      line: { type: "string", minLength: 1, maxLength: 60 },
      price: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["line", "price"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const day = Math.floor(Date.now() / DAY) * DAY;
    await ctx.as().db.collection<Rate>("contact_rate").updateOne(
      { _id: `${input.line}|spent@${day}` },
      { $inc: { spent: input.price }, $set: { until: day + DAY } },
      { upsert: true, ...UNANSWERED },
    );
  },
});
