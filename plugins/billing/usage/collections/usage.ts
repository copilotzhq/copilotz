/** The ledger: one record per use, rated as it was recorded. Appended only. */
import {
  defineCollection,
  type Filter,
  type Infer,
  people,
  type ReadCollection,
} from "../../../../runtime/mod.ts";
import { rollupsOf } from "../shared/settings.ts";
import { priceOnly, totals } from "../shared/totals.ts";

export const usageSchema = {
  type: "object",
  properties: {
    meter: { type: "string" },
    subject: { type: "string" },
    /** The catalog entry it was priced by, when no rate named it. */
    catalog: { type: "string" },
    quantities: { type: "object", additionalProperties: { type: "number" } },
    tags: { type: "object", additionalProperties: { type: "string" } },
    /** USD. */
    cost: { type: "number" },
    price: { type: "number" },
    /** Each by part (USD): the units, `input` and `output` less the parts priced apart. */
    costs: { type: "object", additionalProperties: { type: "number" } },
    prices: { type: "object", additionalProperties: { type: "number" } },
    /** What caching saved (USD), less what writing the cache cost more. */
    saved: {
      type: "object",
      properties: { cost: { type: "number" }, price: { type: "number" } },
    },
    /**
     * Who rated each: `app`, or the catalog and its date; `cost` for a price at
     * cost. A record without a price's (from before every use had one) is
     * priced at its cost.
     */
    rated: { type: "object" },
    /** What nothing priced: `cost`, `price`. */
    unpriced: { type: "array", items: { type: "string" } },
    /** An adjustment: the record whose rating it corrects (its quantities are none). */
    adjusts: { type: "string" },
    /** "adjustment" for one; absent for a use. */
    kind: { type: "string" },
    at: { type: "string" },
  },
  required: ["meter", "subject", "quantities", "at"],
} as const;

export type UsageRecord = Infer<typeof usageSchema> & { _id: string };

/**
 * What the ledger is read by: time, and time per meter, subject and thread.
 * An app adds its own (`collections: { usage: { indexes: [["tags.tenant", "at"]] } }`).
 */
export const INDEXES = [["at"], ["meter", "at"], ["subject", "at"], ["tags.thread", "at"]];

export const usage = defineCollection({
  records: true,
  schema: usageSchema,
  indexes: INDEXES,
  queries: {
    /**
     * Totals of the records matching `filter`, grouped `by` fields
     * (`["day", "tags.agent"]`), summing `units` (input, output, cached,
     * cacheWrite, reasoning, seconds and calls by default). Whole closed
     * days come from their rollups when those hold what's asked.
     */
    totals: {
      // A person sees their own usage, at its price; the system, everyone's, cost too.
      allow: people,
      run: async (
        records,
        params: { filter?: Filter; by?: string[]; units?: string[] } = {},
        ctx,
      ) => {
        const person = ctx.actor?.kind === "person";
        const found = await totals(
          records as ReadCollection<UsageRecord>,
          person
            ? { ...params, filter: { ...params.filter, "tags.person": ctx.actor!.id } }
            : params,
          { db: ctx.db, rollups: rollupsOf(ctx) },
        );
        return person ? found.map(priceOnly) : found;
      },
    },
    /** The records matching `filter`, newest first. */
    list: (records, params: { filter?: Filter; limit?: number } = {}) =>
      records.find(params.filter ?? {}, { sort: { at: -1 }, limit: params.limit ?? 100 }),
  },
});
