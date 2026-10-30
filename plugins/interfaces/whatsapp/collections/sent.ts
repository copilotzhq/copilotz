/**
 * What went out to WhatsApp: each part of an agent's message, once sent
 * (`<message>:<part>`), with WhatsApp's id for it. A ledger: a retried
 * delivery sends only the parts not on it, and a reply quoting one finds
 * the message it was.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const sentSchema = {
  type: "object",
  properties: {
    /** The chat message it was (part of). */
    message: { type: "string" },
    part: { type: "integer" },
    /** WhatsApp's id for it. */
    wamid: { type: "string" },
    at: { type: "string" },
  },
  required: ["message", "part", "wamid", "at"],
} as const;

export const sent = defineCollection({
  schema: sentSchema,
  records: true,
  indexes: [["message"], ["wamid"]],
});

export type WhatsAppSent = Infer<typeof sentSchema> & { _id: string };
