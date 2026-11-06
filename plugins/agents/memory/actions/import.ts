/**
 * `memory.import`: memories moving in from another app, as they were: each
 * with what it says, whom it's about (`person:<id>`, `agent:<name>`,
 * `thread:<id>` or `everyone`), who wrote it (`by`: an agent, or a person's
 * id) and when, in a space (`in`), where it's recalled as any memory
 * learned there. Each is embedded as it's kept (with an embedder), so recall
 * finds it by meaning. Its id is the importer's: importing again replaces
 * what it made. The system's alone (a migration), and unrecorded: the
 * memories it writes are their own record.
 */
import { defineAction, invalid } from "../../../../runtime/mod.ts";
import type { Memory } from "../collections/memory.ts";
import { vectors } from "../shared/settings.ts";

/** A time with its zone: `2025-03-01T12:00:00Z`, `2025-03-01T09:00:00.123-03:00`. */
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whom a memory is about, as memory says it. */
const ABOUT = /^(?:everyone|(?:person|agent|thread):.+)$/;

/** A time as the store keeps it (`toISOString`), or `invalid` naming what it was. */
function isoOf(value: string, what: string): string {
  const ms = ZONED.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw invalid(`${what}: a time with its zone (ISO 8601), not "${value}"`);
  return new Date(ms).toISOString();
}

const time = { type: "string", maxLength: 40 } as const;

export const importAction = defineAction({
  description: "Brings in memories from another app, as they were, in a space",
  record: false,
  input: {
    type: "object",
    properties: {
      /** The space they were learned in. */
      in: { type: "string", minLength: 1 },
      memories: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          properties: {
            /** The memory's id, the importer's. */
            id: { type: "string", minLength: 1, maxLength: 200 },
            text: { type: "string", minLength: 1 },
            about: { type: "string", pattern: ABOUT.source },
            /** Always in mind, rather than recalled when relevant. */
            core: { type: "boolean" },
            /** Who wrote it: an agent's name, or a person's id. */
            by: { type: "string", minLength: 1 },
            /** When it was learned, and last changed, with their zone. */
            at: time,
            updated: time,
          },
          required: ["id", "text", "about", "by", "at"],
          additionalProperties: false,
        },
      },
    },
    required: ["memories"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const ids = new Set<string>();
    const kept = input.memories.map((m, n) => {
      if (ids.has(m.id)) throw invalid(`Memory "${m.id}" is given twice.`);
      ids.add(m.id);
      return {
        _id: m.id,
        text: m.text,
        about: m.about,
        ...(m.core ? { core: true } : {}),
        by: m.by,
        ...(input.in ? { in: input.in } : {}),
        at: isoOf(m.at, `Memory ${n + 1}`),
        ...(m.updated ? { updated: isoOf(m.updated, `Memory ${n + 1}'s change`) } : {}),
      };
    });
    // Embedded together, before anything is written: a failing embedder writes nothing.
    const embeddings = kept.length
      ? await vectors(ctx, kept.map((m) => m.text), input.in ? { space: input.in } : {})
      : undefined;
    await ctx.transaction(async (tx) => {
      const memories = tx.db.collection<Omit<Memory, "_id"> & { embedding?: number[] }>("memory");
      for (const [i, { _id, ...memory }] of kept.entries()) {
        await memories.replaceOne(
          { _id },
          { ...memory, ...(embeddings ? { embedding: embeddings[i] } : {}) },
          { upsert: true, writeConcern: { w: 0 } },
        );
      }
    });
    return { memories: kept.length };
  },
});
