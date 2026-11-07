/**
 * Email sign-in's counters, for its limits: messages to an address an hour,
 * tries at an address's password, codes and links in 15 minutes, and all a
 * caller asked in 15 minutes. Each counter is one window's
 * (`<what>|<whose>@<window start>`), counting until `until` (ms), and goes
 * after it (`email.prune`). Kept in memory: gone on restart.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const rateSchema = {
  type: "object",
  properties: { count: { type: "integer" }, until: { type: "integer" } },
  required: ["until"],
} as const;

export const rate = defineCollection({ durable: false, schema: rateSchema });

export type Rate = Infer<typeof rateSchema> & { _id: string };
