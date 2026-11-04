/**
 * Callers a line's people blocked (`voice.block`), by the line and a hash
 * of the caller's number (`<line>:<sha256>`; see shared/caller.ts): their
 * calls are rejected as busy, before they're answered. Kept apart from the
 * calls, so erasing a contact (`contact.forget`) doesn't let them in again.
 * Blocking a caller whose number was hidden blocks every hidden number on
 * the line. No events.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const blocked = defineCollection({
  schema: {
    type: "object",
    properties: { line: { type: "string" }, at: { type: "string" } },
    required: ["line", "at"],
  },
  events: false,
});
