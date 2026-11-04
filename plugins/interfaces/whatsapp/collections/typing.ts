/**
 * Chats an agent is answering on WhatsApp, by thread: the message it's
 * answering (WhatsApp's id) and when "typing…" was last shown for it, so it
 * shows again while the agent works on (WhatsApp hides it after 25 seconds).
 * Kept in memory: gone on restart, when it matters least.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const typingSchema = {
  type: "object",
  properties: {
    number: { type: "string" },
    /** The message being answered. */
    wamid: { type: "string" },
    /** When it came. */
    at: { type: "string" },
    /** When "typing…" was last shown. */
    shown: { type: "string" },
  },
  required: ["number", "wamid", "at", "shown"],
} as const;

export const typing = defineCollection({ durable: false, schema: typingSchema });

export type WhatsAppTyping = Infer<typeof typingSchema> & { _id: string };
