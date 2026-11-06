/**
 * Email sign-in's addresses: one per address it knows, by the address itself
 * (`_id`, lowercased), so one address is never two accounts. Whose it is
 * (`person`), whether they proved it's theirs (`verified`: a code, a link,
 * or an import that says so), and the hash of their password (`hash`, a
 * private field: no event, no actor's read and no View ever holds it; none
 * until one is set). Only the system reads or writes it (the plugin's
 * guard): every change is on the record, without the hash.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const loginSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    verified: { type: "boolean" },
    /** Its password's hash (see shared/password.ts): private. */
    hash: { type: "string" },
    /** When its password was last set. */
    changed: { type: "string" },
    at: { type: "string" },
  },
  required: ["person", "verified", "at"],
} as const;

export const login = defineCollection({
  schema: loginSchema,
  private: ["hash"],
  indexes: [["person"]],
});

export type Login = Infer<typeof loginSchema> & { _id: string };
