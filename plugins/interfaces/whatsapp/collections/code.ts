/**
 * Codes that link a phone (`<number>:<code>`): a person asks for one in the
 * app, sends it to the number from WhatsApp, and that phone is theirs. One
 * works once, for minutes. Each person reads their own (the app shows it,
 * and sees it go once it's used). No events: whoever reads the log can't
 * link a phone as someone else; the link is what's on the record.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const codeSchema = {
  type: "object",
  properties: {
    /** The connected number it's for. */
    number: { type: "string" },
    /** Six digits. */
    code: { type: "string" },
    /** Whose phone it links. */
    person: { type: "string" },
    expires: { type: "string" },
    at: { type: "string" },
  },
  required: ["number", "code", "person", "expires", "at"],
} as const;

export const code = defineCollection({
  schema: codeSchema,
  events: false,
  indexes: [["person"]],
});

export type WhatsAppCode = Infer<typeof codeSchema> & { _id: string };
