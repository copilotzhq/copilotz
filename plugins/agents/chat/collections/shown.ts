/**
 * What went out after agents' answers, beyond what they wrote (additions: a
 * carousel of trips, buttons to pay): each addition once per chat per key
 * (`<thread>:<key>`), with the answer it followed, the medium it went by, a
 * line for the model (`note`), and whether its fallback went instead
 * (`fallback`: Meta refused the carousel, its text list went). A ledger: no
 * events, and writing one again changes nothing, so a retried delivery
 * shows nothing twice. Part of its chat: who reaches the chat reads it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const shownSchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    /** The chat's space. */
    in: { type: "string" },
    /** The addition's key: `trips:9f2a`. */
    key: { type: "string" },
    /** The answer it went after. */
    after: { type: "string" },
    /** How it went: `whatsapp`. */
    medium: { type: "string" },
    fallback: { type: "boolean" },
    /** What the model is told it was: "6 trips as a carousel". */
    note: { type: "string" },
    at: { type: "string" },
  },
  required: ["thread", "key", "after", "medium", "at"],
} as const;

export const shown = defineCollection({
  schema: shownSchema,
  records: true,
  indexes: [["thread"]],
});

export type AdditionShown = Infer<typeof shownSchema> & { _id: string };
