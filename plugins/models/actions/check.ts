/**
 * `models.check`: whether a model can be called as configured (its provider,
 * adapter and settings), for a port. Other plugins' startup checks ask it
 * about the models they're configured with, so a mistake stops the runtime
 * from starting.
 *
 * `models.efforts` `{ model }`: the efforts the catalog says a model takes
 * (`none` first when its reasoning can be turned off), `[]` when it doesn't
 * reason, null when the catalog doesn't say: for whoever sets one on a model
 * chosen elsewhere. Only the configuration: nothing is read.
 */
import { defineAction } from "../../../runtime/mod.ts";
import { type ModelRef, resolve } from "../shared/choice.ts";
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

export const efforts = defineAction({
  description: "The efforts the catalog says a model takes; null when it doesn't say",
  record: false,
  input: {
    type: "object",
    properties: { model: { type: ["string", "object", "array"] } },
    required: ["model"],
    additionalProperties: false,
  },
  run: (ctx, input) => {
    const [first] = resolve(ctx.resources, input.model as ModelRef);
    const reasoning = first?.info?.reasoning;
    if (reasoning === false) return [];
    if (!reasoning?.effort) return null;
    return [...(reasoning.toggle ? ["none"] : []), ...reasoning.effort];
  },
});
