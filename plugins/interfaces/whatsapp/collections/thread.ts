/**
 * Conversations that happen on WhatsApp, by thread id: the number and phone
 * they're with, and whose phone it is: a person's, or a contact's (a
 * customer on an open number). What agents say there to them goes out to
 * the phone, even after they've moved on to a new conversation. Each person
 * reads their own.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const threadSchema = {
  type: "object",
  properties: {
    number: { type: "string" },
    /** The phone's WhatsApp id. */
    phone: { type: "string" },
    person: { type: "string" },
    contact: { type: "string" },
    at: { type: "string" },
  },
  required: ["number", "phone", "at"],
} as const;

export const chat = defineCollection({ schema: threadSchema, indexes: [["contact"]] });

export type WhatsAppThread = Infer<typeof threadSchema> & { _id: string };
