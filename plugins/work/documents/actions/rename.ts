/**
 * `document.rename`: a document's new title, as its next version (its text
 * as it is), by someone who may change it (the rules say).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { keyOf, TITLE } from "../shared/text.ts";
import { commit, fail, load, plainly } from "../shared/write.ts";

export const renameAction = defineAction({
  description: "Renames a document",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1 },
      title: { type: "string", maxLength: TITLE },
    },
    required: ["document", "title"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const title = input.title.trim();
    if (!title) throw fail("A document needs a title.", "invalid");
    return await ctx.transaction(async (tx) => {
      const doc = await load(tx.db, input.document);
      return await commit(tx, doc, { title, text: doc.text, kind: "rename" }, {
        by: keyOf(ctx.actor!),
      });
    }).catch((error) => {
      throw plainly(error);
    });
  },
});
