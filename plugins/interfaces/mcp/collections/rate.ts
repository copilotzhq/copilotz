/**
 * How many calls each conversation, each caller's address and each line
 * took this minute, and how many new conversations the line, each user and
 * each address started this hour, for the line's `limits`. Each counter is
 * one window's (`<line>|<what>|<who>@<window>`), counting until `until`
 * (ms), and goes after it (`mcp.prune`). Only calls taken count, and a new
 * conversation only once it's made. Kept in memory: gone on restart, when
 * it matters least.
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
