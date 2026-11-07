/**
 * `image.generate`: images from a prompt and, if given, images to work from
 * (see shared/image.ts). Recorded: it costs and takes a while, so a job
 * that runs again finds its call done instead of paying twice. Its answer
 * names the images kept (the `image` collection), never their content.
 */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { generateImages, type ImageReference } from "../shared/image.ts";

export const generateImage = defineAction({
  description: "Images from a prompt and images to work from, kept and named by id",
  input: {
    type: "object",
    properties: {
      model: { type: ["string", "object", "array"] },
      prompt: { type: "string", minLength: 1 },
      /** An image made here (`id`), a document the caller may read (`id`, `collection`), or inline (`data`). */
      references: {
        type: "array",
        maxItems: 14,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            collection: { type: "string", minLength: 1 },
            data: { type: "string", minLength: 1 },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      count: { type: "integer", minimum: 1, maximum: 4 },
      aspectRatio: { type: "string", pattern: "^[0-9]+:[0-9]+$" },
      size: { type: "string", minLength: 1 },
      /** What it's for (thread, space, purpose…): its usage record's tags, and its images'. */
      tags: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["model", "prompt"],
    additionalProperties: false,
  },
  run: (ctx, { model, references, tags, ...rest }) =>
    generateImages(ctx, {
      ...rest,
      model: model as ModelRef,
      ...(references ? { references: references as ImageReference[] } : {}),
      ...(tags ? { tags: tags as Record<string, string> } : {}),
    }),
});
