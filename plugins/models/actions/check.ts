/**
 * `models.check`: whether a model can be called as configured (its provider,
 * adapter and settings), for a port. Other plugins' startup checks ask it
 * about the models they're configured with, so a mistake stops the runtime
 * from starting.
 */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { embedder } from "../shared/embed.ts";
import { chooseModels } from "../shared/generate.ts";
import { transcribers } from "../shared/transcribe.ts";

export const check = defineAction({
  description: "Throws what's wrong with a model for a port; nothing when it can be called",
  record: false,
  input: {
    type: "object",
    properties: {
      model: { type: ["string", "object", "array"] },
      port: { enum: ["llm", "embeddings", "transcription"] },
    },
    required: ["model", "port"],
    additionalProperties: false,
  },
  run: (ctx, input) => {
    const model = input.model as ModelRef;
    if (input.port === "llm") chooseModels(ctx, model);
    else if (input.port === "embeddings") embedder(ctx, model);
    else transcribers(ctx, model);
  },
});
