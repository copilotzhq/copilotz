/**
 * `maintenance.read`: one collection read (find, findOne, countDocuments,
 * aggregate), as the maintenance key's holder, through the owner: from its
 * cache, with large values brought back in, every field included. Reads
 * record nothing; a find answers at most `limit` documents and says whether
 * there were more.
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
  description: "One collection read (find, findOne, countDocuments, aggregate), for operators.",
  input: {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1 },
      op: { enum: READS },
      filter: object,
      sort: { type: "object", additionalProperties: { enum: [1, -1] } },
      limit: { type: "integer", minimum: 0 },
      skip: { type: "integer", minimum: 0 },
      pipeline: { type: "array", items: object },
    },
    required: ["collection", "op", "limit"],
    additionalProperties: false,
  },
  record: false,
  allow: isMaintenance,
  run: async (ctx, input) => {
    const docs = ctx.as().db.collection<Doc>(own(input.collection));
    const filter = (input.filter ?? {}) as Filter;
    const { limit } = input;
    // One more than asked says whether there were more.
    const page = <T>(found: T[]) => ({
      docs: found.slice(0, limit),
      truncated: found.length > limit,
    });
    switch (input.op) {
      case "find":
        return page(
          await docs.find(filter, {
            ...(input.sort ? { sort: input.sort } : {}),
            ...(input.skip ? { skip: input.skip } : {}),
            limit: limit + 1,
          }),
        );
      case "findOne":
        return { doc: await docs.findOne(filter, input.sort ? { sort: input.sort } : {}) };
      case "countDocuments":
        return { count: await docs.countDocuments(filter) };
      case "aggregate":
        return page(
          await docs.aggregate(needs(input.pipeline, "aggregate", "pipeline") as Pipeline),
        );
    }
  },
});
