/**
 * What went out to WhatsApp: each part of an agent's message, once sent
 * (`<message>:<part>`), and of what went after it (an addition,
 * `<message>:<key>:<part>`), with WhatsApp's id for it. A ledger: a retried
 * delivery sends only the parts not on it, and a reply quoting one (or a
 * tap on it) finds the message it was, and the addition.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const sentSchema = {
  type: "object",
  properties: {
    /** The chat message it was (part of), or went after. */
    message: { type: "string" },
    /** Its chat. */
    thread: { type: "string" },
    /** The addition it was part of: `trips:9f2a`. */
    key: { type: "string" },
    /** WhatsApp's id for it. */
    wamid: { type: "string" },
    at: { type: "string" },
  },
  required: ["message", "wamid", "at"],
} as const;

export const sent = defineCollection({
  schema: sentSchema,
  records: true,
  indexes: [["message"], ["wamid"]],
});

export type WhatsAppSent = Infer<typeof sentSchema> & { _id: string };
