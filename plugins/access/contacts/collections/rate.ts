/**
 * The web lines' counters, for their `limits`: new visitors an hour from
 * each address; a visitor's messages a minute and a day, its address's, the
 * line's a minute; and new visitors who speak, an hour. Each counter is one
 * window's (`<line>|<what>@<window start>`), counting until `until` (ms), and
 * goes after it (`contact.prune`). Addresses are counted by their tag (an
 * HMAC), never as they are. Beside them, what a visitor who hasn't spoken
 * will be counted from (`from|<contact>`: its address's tag), for a day.
 * Kept in memory: gone on restart, when it matters least.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const rate = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: {
      until: { type: "integer" },
      count: { type: "integer" },
      tag: { type: "string" },
    },
    required: ["until"],
  },
});
