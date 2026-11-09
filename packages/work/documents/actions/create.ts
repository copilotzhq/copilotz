/**
 * `document.create`: a new document in a space the person may write in (the
 * rules say), its first version: a title ("Untitled" until they name it)
 * and, if they start from something, its text.
 */
import { defineAction, people } from "copilotz";
import { keyOf, LIMIT, TITLE, UNTITLED } from "../shared/text.ts";
import { create, plainly } from "../shared/write.ts";

export const createAction = defineAction({
  description: "Makes a document in a space",
  input: {
    type: "object",
    properties: {
      in: { type: "string", minLength: 1 },
      title: { type: "string", maxLength: TITLE },
      text: { type: "string", maxLength: 4 * LIMIT },
    },
    required: ["in"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const title = input.title?.trim() || UNTITLED;
    return await ctx.transaction((tx) =>
      create(tx, input.in, title, input.text ?? "", { by: keyOf(ctx.actor!) })
    ).catch((error) => {
      throw plainly(error);
    });
  },
});
