/**
 * Money that came in, however it came: appended, one for each thing a channel
 * collected (`_id`: `<channel>:<ref>`). What commissions and accounts read,
 * so they never need to know who collected it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

export const paymentSchema = {
  type: "object",
  properties: {
    /** `manual`, `stripe`… and which account of it (a seller). */
    channel: { type: "string" },
    seller: { type: "string" },
    ref: { type: "string" },
    /** What was collected, in its currency's main unit, before tax. */
    amount: { type: "number" },
    currency: { type: "string" },
    /** USD per unit of its currency, when it isn't USD. */
    rate: { type: "number" },
    /** What the channel kept. */
    fee: { type: "number" },
    /** What it was for, and the credits it bought (USD). */
    purpose: { type: "string", enum: ["seats", "credits", "contract", "refund"] },
    credits: { type: "number" },
    note: { type: "string" },
    by: { type: "string" },
    /** From a test mode: no real money. */
    sandbox: { type: "boolean" },
    at: { type: "string" },
  },
  required: ["channel", "ref", "amount", "currency", "purpose", "at"],
} as const;

export type Payment = Infer<typeof paymentSchema> & { _id: string };

export const payment = defineCollection({ records: true, schema: paymentSchema });
