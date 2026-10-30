/**
 * Conversations that happen on WhatsApp, by thread id: the number and phone
 * they're with, and whose phone it is. What agents say there to that person
 * goes out to the phone, even after they've moved on to a new conversation.
 * Each person reads their own.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const threadSchema = {
  type: "object",
  properties: {
    number: { type: "string" },
    /** The phone's WhatsApp id. */
    phone: { type: "string" },
    person: { type: "string" },
    at: { type: "string" },
  },
  required: ["number", "phone", "person", "at"],
} as const;

export const chat = defineCollection({ schema: threadSchema });

export type WhatsAppThread = Infer<typeof threadSchema> & { _id: string };
