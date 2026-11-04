/**
 * `maintenance.write`: one collection operation, as the maintenance key's
 * holder, through the owner's normal write path: checked against the
 * collection's schema, recorded as its events, cached and heard by
 * Processors like any write. It runs as the system on the record (the
 * events say `via` the maintenance actor), so no rule keeps it from a
 * document; its call, with what it was asked, is on the record too.
 */
import { defineAction, type Doc, type Filter } from "../../../../runtime/mod.ts";
import { isMaintenance } from "../contract.ts";
import { needs, own } from "../shared/ops.ts";

/** The writes it runs, by their MongoDB names. */
export const WRITES = [
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
] as const;

export const isWrite = (op: string): op is typeof WRITES[number] =>
  (WRITES as readonly string[]).includes(op);

const object = { type: "object" } as const;

export const writeAction = defineAction({
  description: "One collection operation (insertOne…deleteMany), for the app's operators.",
  input: {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1 },
      op: { enum: WRITES },
      doc: object,
      docs: { type: "array", items: object, minItems: 1 },
      filter: object,
      update: object,
      upsert: { type: "boolean" },
    },
    required: ["collection", "op"],
    additionalProperties: false,
  },
  allow: isMaintenance,
  run: async (ctx, input) => {
    const docs = ctx.as().db.collection<Doc>(own(input.collection));
    const { op } = input;
    const filter = () => needs(input.filter, op, "filter") as Filter;
    const update = () =>
      needs(input.update, op, "update") as Record<string, Record<string, unknown>>;
    const upsert = input.upsert ? { upsert: true } : {};
    switch (op) {
      case "insertOne":
        return await docs.insertOne(needs(input.doc, op, "doc") as Doc);
      case "insertMany":
        return await docs.insertMany(needs(input.docs, op, "docs") as Doc[]);
      case "updateOne":
        return await docs.updateOne(filter(), update(), upsert);
      case "updateMany":
        return await docs.updateMany(filter(), update(), upsert);
      case "replaceOne":
        return await docs.replaceOne(filter(), needs(input.doc, op, "doc") as Doc, upsert);
      case "deleteOne":
        return await docs.deleteOne(filter());
      case "deleteMany":
        return await docs.deleteMany(filter());
    }
  },
});
