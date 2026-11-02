/**
 * Credits an org was given or bought, in USD, appended and never changed: the
 * same `_id` again is the one already kept, so a grant that comes from
 * something (a period, a code, a payment) can't land twice. A negative amount
 * takes credits away.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

export const creditSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["trial", "plan", "gift", "referral", "purchase", "waived", "adjustment"],
    },
    amount: { type: "number" },
    at: { type: "string" },
    /** The first day (UTC, `YYYY-MM-DD`) it no longer counts; none: it doesn't expire. */
    expires: { type: "string" },
    /** What to show for it, and who gave it. */
    note: { type: "string" },
    by: { type: "string" },
  },
  required: ["kind", "amount", "at"],
} as const;

export type Credit = Infer<typeof creditSchema> & { _id: string };

export const credit = defineCollection({ records: true, schema: creditSchema });
