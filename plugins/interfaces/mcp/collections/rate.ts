/**
 * How many calls each conversation and each line took this minute, and how
 * many new conversations the line and each user started this hour, for the
 * line's `limits`: `<line>|chat|<thread>`, `<line>|line`, `<line>|chats` and
 * `<line>|user|<user>`, each counting until `until` (ms). Kept in memory:
 * gone on restart, when it matters least.
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
