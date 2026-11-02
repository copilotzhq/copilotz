/**
 * Gift codes: credits waiting to be claimed into an org, which may not exist
 * yet. Kept here because they aren't any org's until someone claims one. Only a
 * code's hash is kept (`_id`), and the code is shown once. A purchase made
 * outside the app can wait the same way.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const creditCodeSchema = {
  type: "object",
  properties: {
    /** USD, and the first day the credits no longer count (`YYYY-MM-DD`); none: they don't lapse. */
    amount: { type: "number" },
    expires: { type: "string" },
    /** The last moment it can be claimed; none: until it is. */
    until: { type: "string" },
    /** What it's for, as the credits will say. */
    note: { type: "string" },
    by: { type: "string" },
    at: { type: "string" },
    /** Who took it, and when; or that it was taken back. */
    org: { type: "string" },
    person: { type: "string" },
    claimed: { type: "string" },
    revoked: { type: "string" },
  },
  required: ["amount", "by", "at"],
} as const;

export const creditCode = defineCollection({ schema: creditCodeSchema });

export type CreditCode = Infer<typeof creditCodeSchema> & { _id: string };
