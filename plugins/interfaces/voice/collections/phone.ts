/**
 * Numbers that called a line, by line and number (`<line>:+5511…`): the
 * contact each caller is, and the chat they're in, so calling back goes on
 * where they were (until the line's `gap`). A caller whose number Twilio
 * doesn't give (hidden) is a new contact each call, and isn't here. No
 * events; nothing outside reads it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const phoneSchema = {
  type: "object",
  properties: {
    line: { type: "string" },
    phone: { type: "string" },
    contact: { type: "string" },
    /** The chat their calls go to; a new one past the line's gap. */
    thread: { type: "string" },
    at: { type: "string" },
  },
  required: ["line", "phone", "contact", "at"],
} as const;

export const phone = defineCollection({
  schema: phoneSchema,
  events: false,
  private: ["phone"],
  indexes: [["contact"]],
});

export type VoicePhone = Infer<typeof phoneSchema> & { _id: string };
