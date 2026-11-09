/**
 * `document.presence`: a page says who has a document open, and whether
 * they're editing it (`open`, `editing`), every little while, and that
 * they've gone (`gone`). Anyone who may read the document may say so for
 * themselves; it's kept in memory only, and unrecorded (no events), so
 * saying it often costs the log nothing. Entries no page has spoken for in
 * a while go as anyone speaks.
 */
import { defineAction, people } from "copilotz";
import { presenceId, STALE_MS } from "../collections/document-presence.ts";
import type { Document } from "../collections/document.ts";
import { keyOf } from "../shared/text.ts";

export const presenceAction = defineAction({
  description: "Says who has a document open, and whether they're editing it",
  record: false,
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1 },
      /** The page saying it: one of the person's tabs. */
      page: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
      state: { enum: ["open", "editing", "gone"] },
    },
    required: ["document", "page", "state"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const doc = await ctx.db.collection<Document>("document").findOne({ _id: input.document });
    if (!doc) return { present: false };
    const who = keyOf(ctx.actor!);
    const _id = presenceId(doc._id, who, input.page);
    const presence = ctx.db.collection("documentPresence");
    if (input.state === "gone") await presence.deleteOne({ _id });
    else {
      await presence.replaceOne(
        { _id },
        { document: doc._id, in: doc.in, who, state: input.state, at: new Date().toISOString() },
        { upsert: true },
      );
    }
    await presence.deleteMany({
      document: doc._id,
      at: { $lt: new Date(Date.now() - STALE_MS).toISOString() },
    });
    return { present: input.state !== "gone" };
  },
});
