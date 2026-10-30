/**
 * `llm.generate`: one model call, its whole answer. Unrecorded: in a job it
 * runs inline. From outside, `stream` names a channel that receives
 * `{ type: "delta", text }` frames while the answer streams.
 */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { complete } from "../shared/generate.ts";
import type { LlmMessage, LlmTool } from "../shared/types.ts";
import { request } from "../shared/request.ts";

export const generate = defineAction({
  description: "One model call: the whole answer (and its deltas on a channel, when named)",
  record: false,
  input: {
    type: "object",
    properties: { ...request, stream: { type: "string" } },
    required: ["model", "messages"],
    additionalProperties: false,
  },
  run: (ctx, input) => {
    const live = input.stream ? ctx.stream(input.stream) : undefined;
    return complete(ctx, {
      model: input.model as ModelRef,
      instructions: input.instructions,
      messages: input.messages as LlmMessage[],
      tools: input.tools as LlmTool[] | undefined,
      tags: input.tags as Record<string, string> | undefined,
    }, live && ((text) => live.write({ type: "delta", text })));
  },
});
