/**
 * `document.restore`: an old version brought back, as a new one (its title
 * and text over what's there now; the versions between stay in History).
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { type DocumentVersion, versionId } from "../collections/document-version.ts";
import { keyOf } from "../shared/text.ts";
import { commit, fail, load, plainly } from "../shared/write.ts";

export const restoreAction = defineAction({
  description: "Brings back an old version of a document, as its next version",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
    },
    required: ["document", "version"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    return await ctx.transaction(async (tx) => {
      const doc = await load(tx.db, input.document);
      const old = await tx.db.collection<DocumentVersion>("documentVersion").findOne({
        _id: versionId(doc._id, input.version),
      });
      if (!old) throw fail(`This document has no version ${input.version}.`, "not_found");
      return await commit(tx, doc, {
        title: old.title,
        text: old.text,
        kind: "restore",
        from: input.version,
      }, { by: keyOf(ctx.actor!) });
    }).catch((error) => {
      throw plainly(error);
    });
  },
});
