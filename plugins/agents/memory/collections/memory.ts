/** Memories: one statement each, with an embedding vector field for semantic recall. */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { LIMIT, readable, RELEVANT, type Scope } from "../shared/scope.ts";
import { search } from "../shared/search.ts";

const memorySchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    /** `person:<name>`, `agent:<name>`, `thread:<id>` or `everyone`. */
    about: { type: "string" },
    /** Always in mind, rather than recalled when relevant. */
    core: { type: "boolean" },
    /**
     * The space it was learned in (with the access plugin): it lives there,
     * and recalling it elsewhere (`recall` with `in`) carries that space, as
     * reading anything does.
     */
    in: { type: "string" },
    /** Who wrote it: an agent, or `memory` (the extractor). */
    by: { type: "string" },
    source: {
      type: "object",
      properties: { thread: { type: "string" }, message: { type: "string" } },
    },
    /** What it said before its last update. */
    was: { type: "string" },
    at: { type: "string" },
    updated: { type: "string" },
    /** When it was forgotten; forgotten memories stay, out of sight, for the record. */
    forgotten: { type: "string" },
  },
  required: ["text", "about", "by", "at"],
} as const;

export type Memory = Infer<typeof memorySchema> & { _id: string };

export const memoryCollection = defineCollection({
  schema: memorySchema,
  vectors: ["embedding"],
  queries: {
    /** Core memories a scope can read, oldest first: what agents always have in mind. */
    core: (memories, scope: Scope) =>
      memories.find({ ...readable(scope), core: true }, { sort: { at: 1 }, limit: LIMIT.core }),
    /** Everything remembered (not forgotten), newest first: everywhere, or learned in a space (`in`). */
    list: {
      allow: (actor) => actor.kind === "person",
      run: (memories, p: { limit?: number; in?: string } = {}) =>
        memories.find({ forgotten: { $exists: false }, ...(p.in ? { in: p.in } : {}) }, {
          sort: { at: -1 },
          limit: p.limit ?? 50,
        }),
    },
    /** The memories most relevant to a text, for a scope (core ones aside). */
    relevant: (_memories, p: Scope & { text: string }, ctx) =>
      search(ctx, p, p.text, LIMIT.relevant, { least: RELEVANT }),
  },
});
