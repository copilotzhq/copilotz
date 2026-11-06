/**
 * What email sign-in waits on: a sign-up until its address is confirmed
 * (`verify`), a new password's code (`reset`), an invitation's link
 * (`invite`). Never a code or a token itself: what's kept is its seal
 * (`hash`, or an invitation's `_id`: see shared/codes.ts), with a sign-up's
 * password already hashed (`pending`), both private. A code works until
 * `expires` and for `CODE_TRIES` wrong tries; a sign-up stays a week
 * (`until`), so signing in with its password sends a new code. Each is used
 * once. Its changes record no events: they're short-lived, and an address
 * someone mistyped has no place in the log. Only the system reads it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const codeSchema = {
  type: "object",
  properties: {
    email: { type: "string" },
    purpose: { type: "string", enum: ["verify", "reset", "invite"] },
    /** Its code's seal (a code's); private. */
    hash: { type: "string" },
    /** A sign-up's password, hashed; private. */
    pending: { type: "string" },
    /** The name a sign-up gave. */
    name: { type: "string" },
    /** Wrong tries at its code. */
    tries: { type: "integer" },
    /** When its code or link stops working. */
    expires: { type: "string" },
    /** When it goes. */
    until: { type: "string" },
    at: { type: "string" },
  },
  required: ["email", "purpose", "tries", "expires", "until", "at"],
} as const;

export const code = defineCollection({
  schema: codeSchema,
  events: false,
  private: ["hash", "pending"],
  indexes: [["email", "purpose"], ["until"]],
});

export type Code = Infer<typeof codeSchema> & { _id: string };
