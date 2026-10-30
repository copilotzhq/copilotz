/** `embeddings.embed`: vectors for texts. Unrecorded: in a job, a query or a View it runs inline. */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { embed as embedText } from "../shared/embed.ts";

export const embed = defineAction({
  description: "Vectors for texts",
  record: false,
  input: {
    type: "object",
    properties: {
      model: { type: ["string", "object"] },
      input: { type: "array", items: { type: "string" }, minItems: 1 },
      tags: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["model", "input"],
    additionalProperties: false,
  },
  run: (ctx, input) =>
    embedText(ctx, {
      model: input.model as ModelRef,
      input: input.input,
      tags: input.tags as Record<string, string> | undefined,
    }),
});
