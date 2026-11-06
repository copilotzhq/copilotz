/**
 * Every save of a document, as it was then: its `version`, title and text,
 * who saved it and when (an agent, for whom), how (`kind`: made, saved,
 * renamed, restored from an older one, or an agent's write, append or edit;
 * `merged` when it was saved over someone else's changes, line by line), and
 * what changed (`added` and `removed` lines). It lives in the document's
 * space, so it's read and written as the document is; its `_id` is
 * `<document>:<version>`, so a version is had once. A long text is stored
 * once by its content (the runtime's blobs), so a version that keeps it
 * costs little.
 *
 * Its query `history` (`{ document }`) lists them newest first, without
 * their text: what a document's History shows.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

import type { Without } from "../shared/text.ts";

export { versionId } from "../shared/text.ts";

const versionSchema = {
  type: "object",
  properties: {
    document: { type: "string" },
    /** The document's space. */
    in: { type: "string" },
    version: { type: "integer", minimum: 1 },
    title: { type: "string" },
    text: { type: "string" },
    /** Who saved it: `person:ana`, `agent:north`; for an agent, the person it worked for. */
    by: { type: "string" },
    for: { type: "string" },
    at: { type: "string" },
    kind: {
      enum: ["create", "save", "rename", "restore", "write", "append", "edit"],
    },
    /** Saved over others' changes since `base`, the version it started from, merged by line. */
    merged: { type: "boolean" },
    base: { type: "integer" },
    /** Restored: the version it brought back. */
    from: { type: "integer" },
    /** Lines added and removed since the version before. */
    added: { type: "integer" },
    removed: { type: "integer" },
    /** The title before, when this one changed it. */
    renamed: { type: "string" },
  },
  required: ["document", "in", "version", "title", "text", "by", "at", "kind", "added", "removed"],
} as const;

export type DocumentVersion = Infer<typeof versionSchema> & { _id: string };

/** A version as History lists it: without its text. */
export type Saved = Without<DocumentVersion, "text">;

export const documentVersion = defineCollection({
  schema: versionSchema,
  indexes: [["document", "version"], ["in"]],
  queries: {
    history: {
      allow: (actor) => actor.kind === "person",
      run: async (versions, params: { document: string; limit?: number }) => {
        if (typeof params?.document !== "string") return [];
        const found = await versions.find(
          { document: params.document },
          { sort: { version: -1 }, ...(params.limit ? { limit: Number(params.limit) } : {}) },
        );
        return found.map(({ text: _, ...v }) => v as Saved);
      },
    },
  },
});
