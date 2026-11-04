/**
 * How many visitors each web line let in this hour, all together and from
 * each caller's address, for the line's `limits`. Each counter is one
 * window's (`<line>|<what>@<hour>`), counting until `until` (ms), and goes
 * after it (each arrival clears those past). A place is taken in one write
 * that counts only while there's room, so arrivals at once never pass a
 * limit. Kept in memory: gone on restart, when it matters least.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const rate = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: { until: { type: "integer" }, count: { type: "integer" } },
    required: ["until", "count"],
  },
});
