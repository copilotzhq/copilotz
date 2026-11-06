/**
 * Documents: Markdown that lives in a space (`in`), shared like its chats,
 * with its title and text as they are now and the version they're at (one
 * more with each save; every version is a `documentVersion`), who saved it
 * last and when, and who made it and when. Its queries, for front ends:
 *
 * - `list`: a space's documents (`{ in }`), latest saved first, each with
 *   how it opens (`excerpt`) instead of its whole text;
 * - `recent`: the latest saved anywhere the asker reaches (`{ limit }`),
 *   said the same way: what the command palette goes to.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { excerptOf, type Without } from "../shared/text.ts";

const documentSchema = {
  type: "object",
  properties: {
    /** The space it's in. */
    in: { type: "string" },
    title: { type: "string" },
    /** Markdown. */
    text: { type: "string" },
    /** Which version it's at: 1 when made, one more with each save. */
    version: { type: "integer", minimum: 1 },
    /** Its text's size, in bytes. */
    size: { type: "integer" },
    /** Who made it (`person:ana`, `agent:north`), and when. */
    createdBy: { type: "string" },
    createdAt: { type: "string" },
    /** Who saved it last, and when; for an agent, the person it worked for (`savedFor`). */
    savedBy: { type: "string" },
    savedAt: { type: "string" },
    savedFor: { type: "string" },
  },
  required: [
    "in",
    "title",
    "text",
    "version",
    "size",
    "createdBy",
    "createdAt",
    "savedBy",
    "savedAt",
  ],
} as const;

export type Document = Infer<typeof documentSchema> & { _id: string };

/** A document as a list shows it: everything but its text, and how it opens. */
export type Listed = Without<Document, "text"> & { excerpt: string };

export const listed = ({ text, ...doc }: Document): Listed => ({
  ...doc,
  excerpt: excerptOf(text, doc.title),
});

export const document = defineCollection({
  schema: documentSchema,
  indexes: [["in"], ["in", "savedAt"], ["savedAt"]],
  queries: {
    list: {
      allow: (actor) => actor.kind === "person",
      run: async (docs, params: { in: string }) => {
        if (typeof params?.in !== "string") return [];
        const found = await docs.find({ in: params.in }, { sort: { savedAt: -1 } });
        return found.map((d) => listed(d as Document));
      },
    },
    recent: {
      allow: (actor) => actor.kind === "person",
      run: async (docs, params: { limit?: number } = {}) => {
        const limit = Math.min(Math.max(Number(params?.limit) || 30, 1), 100);
        const found = await docs.find({}, { sort: { savedAt: -1 }, limit });
        return found.map((d) => listed(d as Document));
      },
    },
  },
});
