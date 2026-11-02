/**
 * The org's plan (one document, `_id: "plan"`): what it's on, on what terms,
 * since when, and anything waived. The terms are copied here, so a contract
 * is a record like any other, and changing a plan's list doesn't change what
 * an org agreed to. This, not a payment provider, says what an org has.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const waiver = {
  type: "object",
  properties: {
    from: { type: "string" },
    /** When it ends (ISO); none: until lifted. */
    until: { type: "string" },
    reason: { type: "string" },
    by: { type: "string" },
  },
  required: ["from", "reason"],
} as const;

export const planSchema = {
  type: "object",
  properties: {
    /** Which of the app's plans it came from, or the contract's own name. */
    name: { type: "string" },
    terms: {
      type: "object",
      properties: {
        title: { type: "string" },
        /** What a seat pays each period. */
        seat: {
          type: "object",
          properties: { price: { type: "number" }, currency: { type: "string" } },
          required: ["price", "currency"],
        },
        /** Credits (USD): once ever, and each period, flat and per seat. */
        credits: {
          type: "object",
          properties: {
            once: { type: "number" },
            monthly: { type: "number" },
            perSeat: { type: "number" },
          },
        },
        /** The price list that applies (`resources.priceLists`); none: the app's. */
        prices: { type: "string" },
      },
      required: ["title"],
    },
    /** A fixed number of seats (a contract's); none: the org's people, guests apart. */
    seats: { type: "number" },
    /** From when its usage counts against its credits. */
    since: { type: "string" },
    /** Where its periods start: the same day each month. */
    anchor: { type: "string" },
    /** Who collects for it (`manual`, `stripe`…), which of its accounts, and what it's called there. */
    channel: { type: "string" },
    seller: { type: "string" },
    customer: { type: "string" },
    subscription: { type: "string" },
    /** How its payments stand, as its channel last said: `active`, `past_due`, `canceled`. */
    status: { type: "string" },
    /** The month's limit (USD); absent: the app's default; null: none. */
    budget: { type: ["number", "null"] },
    /** Its usage or seats, not charged. Usage is recorded all the same. */
    waived: {
      type: "object",
      properties: {
        usage: waiver,
        seats: {
          type: "object",
          properties: {
            ...waiver.properties,
            /** Whose; none: every seat. */
            people: { type: "array", items: { type: "string" } },
          },
          required: ["from", "reason"],
        },
      },
    },
    at: { type: "string" },
  },
  required: ["name", "terms", "since", "anchor", "at"],
} as const;

export type Plan = Infer<typeof planSchema> & { _id: string };

export const billingPlan = defineCollection({ schema: planSchema });
