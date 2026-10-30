/** OpenAI Responses API, streaming. */
import { post, sse, usageOf } from "../../shared/provider.ts";
import type { LlmAdapter, LlmFile, LlmMessage } from "../../shared/types.ts";
import { OPENAI } from "./openai-compatible.ts";

/** A file as the Responses API takes it: an image, or a PDF. */
const part = (file: LlmFile) =>
  file.type === "application/pdf"
    ? {
      type: "input_file",
      filename: file.name,
      file_data: `data:${file.type};base64,${file.data}`,
    }
    : { type: "input_image", image_url: `data:${file.type};base64,${file.data}` };

const inputOf = (messages: LlmMessage[]) =>
  messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === "tool") {
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.text }];
    }
    if (message.role === "user") {
      if (!message.files?.length) return [{ role: "user", content: message.text }];
      return [{
        role: "user",
        content: [{ type: "input_text", text: message.text }, ...message.files.map(part)],
      }];
    }
    return [
      ...(message.text ? [{ role: "assistant", content: message.text }] : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input),
      })),
    ];
  });

export const openaiResponses: LlmAdapter = {
  media: ["image", "pdf"],
  async *generate(
    {
      connection,
      effort,
      maxTokens,
      temperature,
      options,
      instructions,
      messages,
      tools = [],
      signal,
    },
  ) {
    const response = await post(connection, OPENAI, "/responses", {
      model: connection.model,
      ...(instructions ? { instructions } : {}),
      input: inputOf(messages),
      ...(tools.length
        ? {
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.input,
            // The Responses API is strict unless told: every field required, so a model fills
            // optional ones (an `operation` whose one value is "interrupt"). Ours are optional.
            strict: false,
          })),
        }
        : {}),
      stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...options,
    }, signal);
    for await (const { data } of sse(response.body!)) {
      const event = JSON.parse(data);
      if (event.type === "response.output_text.delta") {
        yield { type: "text", text: event.delta };
      } else if (
        event.type === "response.output_item.done" && event.item?.type === "function_call"
      ) {
        yield {
          type: "tool_call",
          call: {
            id: event.item.call_id,
            name: event.item.name,
            input: JSON.parse(event.item.arguments || "{}"),
          },
        };
      } else if (event.type === "response.completed") {
        const usage = event.response?.usage;
        if (usage) {
          yield {
            type: "usage",
            ...usageOf({
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cached: usage.input_tokens_details?.cached_tokens,
              reasoning: usage.output_tokens_details?.reasoning_tokens,
            }),
          };
        }
      } else if (event.type === "error" || event.type === "response.failed") {
        throw new Error(
          `OpenAI: ${
            event.error?.message ?? event.response?.error?.message ?? "the response failed"
          }`,
        );
      }
    }
  },
};
