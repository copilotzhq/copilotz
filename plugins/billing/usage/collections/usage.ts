/** The ledger: one record per use, rated as it was recorded. Appended only. */
import {
  defineCollection,
  type Filter,
  type Infer,
  type ReadCollection,
} from "../../../../runtime/mod.ts";
import { rollupsOf } from "../shared/settings.ts";
import { totals } from "../shared/totals.ts";

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
    /** Where each came from: `app`, or the catalog and its date. */
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
      // A person sees their own usage; the system, everyone's.
      allow: (actor) => actor.kind === "person",
      run: (
        records,
        params: { filter?: Filter; by?: string[]; units?: string[] } = {},
        ctx,
      ) =>
        totals(
          records as ReadCollection<UsageRecord>,
          ctx.actor?.kind === "person"
            ? { ...params, filter: { ...params.filter, "tags.person": ctx.actor.id } }
            : params,
          { db: ctx.db, rollups: rollupsOf(ctx) },
        ),
    },
    /** The records matching `filter`, newest first. */
    list: (records, params: { filter?: Filter; limit?: number } = {}) =>
      records.find(params.filter ?? {}, { sort: { at: -1 }, limit: params.limit ?? 100 }),
  },
});
