/**
 * `maintenance.read`: one collection read (find, findOne, countDocuments,
 * aggregate), or one of a collection's named queries (`query`, with its
 * `name` and `params`), as the maintenance key's holder, through the owner:
 * from its cache, with large values brought back in, every field included.
 * Reads record nothing; a find answers at most `limit` documents and says
 * whether there were more. A named query runs as the system on the record
 * (as `runtime.query` does with no actor), so its `allow` isn't asked; it
 * checks its params itself, as it does for any caller.
 */
import { defineAction, type Doc, type Filter, type Pipeline } from "../../../../runtime/mod.ts";
import { isMaintenance } from "../contract.ts";
import { needs, own } from "../shared/ops.ts";

/** The reads it runs, by their MongoDB names. */
export const READS = ["find", "findOne", "countDocuments", "aggregate"] as const;

export const isRead = (op: string): op is typeof READS[number] =>
  (READS as readonly string[]).includes(op);

const object = { type: "object" } as const;

export const readAction = defineAction({
  description: "One collection read (find…aggregate) or named query, for the app's operators.",
  input: {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1 },
      op: { enum: [...READS, "query"] },
      filter: object,
      sort: { type: "object", additionalProperties: { enum: [1, -1] } },
      limit: { type: "integer", minimum: 0 },
      skip: { type: "integer", minimum: 0 },
      pipeline: { type: "array", items: object },
      /** A named query's name, and the params it takes. */
      name: { type: "string", minLength: 1 },
      params: {},
    },
    required: ["collection", "op"],
    additionalProperties: false,
  },
  record: false,
  allow: isMaintenance,
  run: async (ctx, input) => {
    const docs = ctx.as().db.collection<Doc>(own(input.collection));
    const filter = (input.filter ?? {}) as Filter;
    // One more than asked says whether there were more.
    const page = <T>(found: T[], limit: number) => ({
      docs: found.slice(0, limit),
      truncated: found.length > limit,
    });
    switch (input.op) {
      case "find": {
        const limit = needs(input.limit, "find", "limit");
        return page(
          await docs.find(filter, {
            ...(input.sort ? { sort: input.sort } : {}),
            ...(input.skip ? { skip: input.skip } : {}),
            limit: limit + 1,
          }),
          limit,
        );
      }
      case "findOne":
        return { doc: await docs.findOne(filter, input.sort ? { sort: input.sort } : {}) };
      case "countDocuments":
        return { count: await docs.countDocuments(filter) };
      case "aggregate": {
        const limit = needs(input.limit, "aggregate", "limit");
        // The store stops at one more than asked, whatever the pipeline said: a final
        // `$limit`. A pipeline takes one, last (runtime/aggregate.ts), so one it ends with
        // already is that final one, lowered to the cap.
        const pipeline = needs(input.pipeline, "aggregate", "pipeline") as Pipeline;
        const last = pipeline.at(-1) as { $limit?: unknown } | undefined;
        const capped: Pipeline = last && Object.keys(last).length === 1 && "$limit" in last
          ? [...pipeline.slice(0, -1), { $limit: Math.min(Number(last.$limit), limit + 1) }]
          : [...pipeline, { $limit: limit + 1 }];
        return page(await docs.aggregate(capped), limit);
      }
      case "query":
        return { result: await docs.query(needs(input.name, "query", "name"), input.params ?? {}) };
    }
  },
});
