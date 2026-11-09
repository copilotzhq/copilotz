/**
 * `document.delete`: a document gone, with every version of it and who had
 * it open, by someone who may change it (the rules say). In one commit.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { fail, load, plainly } from "../shared/write.ts";

export const deleteAction = defineAction({
  description: "Deletes a document and its history",
  input: {
    type: "object",
    properties: { document: { type: "string", minLength: 1 } },
    required: ["document"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    return await ctx.transaction(async (tx) => {
      const doc = await load(tx.db, input.document);
      const gone = await tx.db.collection("document").deleteOne({ _id: doc._id });
      if (!gone.deletedCount) {
        throw fail(
          "You can read this document but not delete it: an editor or a manager of its space can.",
          "forbidden",
        );
      }
      const { deletedCount } = await tx.db.collection("documentVersion").deleteMany({
        document: doc._id,
      });
      await tx.db.collection("documentPresence").deleteMany({ document: doc._id });
      return { deleted: true, title: doc.title, versions: deletedCount };
    }).catch((error) => {
      throw plainly(error);
    });
  },
});
