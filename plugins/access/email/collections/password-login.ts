/**
 * Password sign-in's accounts: one per identifier (`_id`, as it's read: see
 * shared/identifiers.ts), so one identifier is never two people. Whose it is
 * (`person`: one each), and the hash of their password (`hash`, a private
 * field: no event, no actor's read and no View ever holds it; none until one
 * is set). Only the system reads or writes it (the plugin's guard): every
 * change is on the record, without the hash.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const passwordLoginSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    /** Its password's hash (see shared/password.ts): private. */
    hash: { type: "string" },
    /** When its password was last set. */
    changed: { type: "string" },
    at: { type: "string" },
  },
  required: ["person", "at"],
} as const;

export const passwordLogin = defineCollection({
  schema: passwordLoginSchema,
  private: ["hash"],
  indexes: [["person"]],
});

export type PasswordLogin = Infer<typeof passwordLoginSchema> & { _id: string };
