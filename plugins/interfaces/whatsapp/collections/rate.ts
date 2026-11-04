/**
 * How many messages each customer's phone sent this minute (`<number>:<phone>`),
 * for its number's `rate`. Kept in memory: gone on restart, when it matters least.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const rate = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: { minute: { type: "integer" }, count: { type: "integer" } },
    required: ["minute", "count"],
  },
});
