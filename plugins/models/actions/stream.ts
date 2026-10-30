/**
 * `llm.stream`: one model call, as it comes: text, tool calls, state and
 * usage chunks. Called from a job (an agent's turn), inline: the stream is
 * handed back as it is, and the call stops with the job's signal.
 */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { generate } from "../shared/generate.ts";
import { request } from "../shared/request.ts";
import type { LlmMessage, LlmTool } from "../shared/types.ts";

export const stream = defineAction({
  description: "One model call, streamed: for a job in the same process",
  record: false,
  // The conversation comes from code in the same process (a turn builds it): checked as a list
  // only, since checking every message would cost more the longer it grows.
  input: {
    type: "object",
    properties: { ...request, messages: { type: "array" } },
    required: ["model", "messages"],
    additionalProperties: false,
  },
  run: (ctx, input) =>
    generate(ctx, {
      model: input.model as ModelRef,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      messages: input.messages as LlmMessage[],
      ...(input.tools ? { tools: input.tools as LlmTool[] } : {}),
      ...(input.tags ? { tags: input.tags as Record<string, string> } : {}),
    }),
});
