/**
 * `document.save`: a person's save, as the document's next version. It says
 * the version it started from (`base`). If someone saved since, the two
 * changes are merged line by line against that version: changes to other
 * lines are saved together (`merged`), and the merged text comes back;
 * changes to the same lines (or two new titles) are refused with
 * `conflict`, saying who saved what's there now, and nothing is written.
 * The same title and text as now saves nothing (`unchanged`).
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { namesFor } from "../../../access/spaces/contract.ts";
import { type DocumentVersion, versionId } from "../collections/document-version.ts";
import { merge, mergeField } from "../shared/merge.ts";
import { keyOf, LIMIT, TITLE, UNTITLED } from "../shared/text.ts";
import { agentNamer, nameOf, peopleOf } from "../shared/who.ts";
import { commit, fail, load, plainly } from "../shared/write.ts";

export const saveAction = defineAction({
  description: "Saves a document's new text (and title) as its next version, " +
    "merging with what others saved since the version it started from",
  input: {
    type: "object",
    properties: {
      document: { type: "string", minLength: 1 },
      /** The version the person started from. */
      base: { type: "integer", minimum: 1 },
      text: { type: "string", maxLength: 4 * LIMIT },
      title: { type: "string", maxLength: TITLE },
    },
    required: ["document", "base", "text"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const author = { by: keyOf(ctx.actor!) };
    const asked = input.title === undefined ? undefined : input.title.trim() || UNTITLED;
    return await ctx.transaction(async (tx) => {
      const doc = await load(tx.db, input.document);
      if (input.base > doc.version) {
        throw fail(`There's no version ${input.base} yet: it's at ${doc.version}.`, "invalid");
      }
      let text = input.text;
      let title = asked ?? doc.title;
      const merging = input.base < doc.version;
      if (merging) {
        const base = await tx.db.collection<DocumentVersion>("documentVersion").findOne({
          _id: versionId(doc._id, input.base),
        });
        const merged = base ? merge(base.text, input.text, doc.text) : undefined;
        const named = asked === undefined
          ? doc.title
          : base
          ? mergeField(base.title, asked, doc.title)
          : undefined;
        if (!merged || merged.conflicts || named === undefined) {
          const names = await namesFor(
            { resources: ctx.resources, db: tx.db },
            peopleOf([doc.savedBy]),
          );
          const who = nameOf(doc.savedBy, agentNamer(ctx), names);
          throw fail(
            `${who} saved version ${doc.version} since you started from version ` +
              `${input.base}, changing the same ${merged?.conflicts ? "lines" : "title"}. ` +
              "Nothing was saved: keep yours over theirs, take theirs, or merge them by hand.",
            "conflict",
            { version: doc.version, by: doc.savedBy, at: doc.savedAt },
          );
        }
        text = merged.text!;
        title = named;
      }
      const written = await commit(tx, doc, {
        title,
        text,
        kind: "save",
        ...(merging ? { merged: true, base: input.base } : {}),
      }, author);
      return {
        ...written,
        ...(merging ? { merged: true, text, title } : {}),
      };
    }).catch((error) => {
      throw plainly(error);
    });
  },
});
