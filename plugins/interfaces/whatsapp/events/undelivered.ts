/**
 * `whatsapp.undelivered`: Meta took a message the number sent and then
 * couldn't deliver it (a failed status on its webhook: a picture it couldn't
 * fetch, say). Its id is WhatsApp's message id, so a status Meta sends again
 * records nothing new.
 */
import type { EventDef } from "../../../../runtime/mod.ts";

export const undelivered: EventDef = {
  description: "A message a connected WhatsApp number sent wasn't delivered",
  schema: {
    type: "object",
    properties: {
      /** The connected number (its id here). */
      number: { type: "string" },
      /** WhatsApp's id for what was sent. */
      wamid: { type: "string" },
      /** Whom it was to (their WhatsApp id). */
      to: { type: "string" },
      /** What Meta said went wrong. */
      errors: { type: "array" },
    },
    required: ["number", "wamid", "to"],
  },
};
