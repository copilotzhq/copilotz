/**
 * `whatsapp.received`: someone sent a connected number a message, as its
 * webhook delivered it (signed by the Meta app). Its id is WhatsApp's
 * message id, so a delivery Meta sends again records nothing new.
 */
import type { EventDef } from "../../../../runtime/mod.ts";

export const received: EventDef = {
  description: "Someone sent a connected WhatsApp number a message",
  schema: {
    type: "object",
    properties: {
      /** The connected number (its id here). */
      number: { type: "string" },
      /** The sender's WhatsApp id. */
      from: { type: "string" },
      /** The name their profile shows. */
      name: { type: "string" },
      /** The message, as WhatsApp sent it. */
      message: { type: "object" },
    },
    required: ["number", "from", "message"],
  },
};
