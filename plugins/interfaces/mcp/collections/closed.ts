/**
 * Conversations that are over for good, by the id they'd have
 * (`contact:<id>`, `thread:<id>`): a contact erased (`contact.forget`), or a
 * chat erased (`chat.erase`). A conversation's ids come from what names it
 * (ChatGPT's session, a handle), so without this the same session would
 * come back to the same ids, and start again what was erased. It holds no
 * personal data: the ids are HMACs. No events.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const closed = defineCollection({
  schema: {
    type: "object",
    properties: { at: { type: "string" } },
    required: ["at"],
  },
  events: false,
});
