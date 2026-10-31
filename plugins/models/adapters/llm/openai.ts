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

/** Where the cache keeps a prefix: a breakpoint, on an input text (OpenAI's models since GPT-5.6). */
const BREAKPOINT = { prompt_cache_breakpoint: { mode: "explicit" } };

/**
 * The messages that carry the breakpoints: each marked `cache`, or, when that
 * one is the model's own (which can't), the user's or tool's before it.
 */
function pointsOf(messages: LlmMessage[]): Set<number> {
  const points = new Set<number>();
  messages.forEach((message, i) => {
    if (!message.cache) return;
    let k = i;
    while (k >= 0 && messages[k].role === "assistant") k--;
    if (k >= 0) points.add(k);
  });
  return points;
}

/**
 * The Responses API's input. The messages in `points` (a user's text, a
 * tool's output) carry a breakpoint: the prefix up to it is kept for the next
 * call, and found there although what came after it this time doesn't come
 * again.
 */
const inputOf = (messages: LlmMessage[], points: Set<number>) =>
  messages.flatMap((message, i): Record<string, unknown>[] => {
    const point = points.has(i);
    if (message.role === "tool") {
      return [{
        type: "function_call_output",
        call_id: message.toolCallId,
        output: point ? [{ type: "input_text", text: message.text, ...BREAKPOINT }] : message.text,
      }];
    }
    if (message.role === "user") {
      if (!message.files?.length && !point) return [{ role: "user", content: message.text }];
      return [{
        role: "user",
        content: [
          { type: "input_text", text: message.text, ...(point ? BREAKPOINT : {}) },
          ...(message.files ?? []).map(part),
        ],
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

/** Models that refused breakpoints (OpenAI's before GPT-5.6, other servers): sent none from then on. */
const pointless = new Set<string>();

/** Whether a refusal is of the breakpoints themselves. */
const refusedPoints = (error: unknown) =>
  (error as { status?: number }).status === 400 &&
  String((error as Error).message).includes("prompt_cache_breakpoint");

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
    const body = (input: Record<string, unknown>[]) => ({
      model: connection.model,
      ...(instructions ? { instructions } : {}),
      input,
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
    });
    const request = (points: Set<number>) =>
      post(connection, OPENAI, "/responses", body(inputOf(messages, points)), signal);
    // Breakpoints, unless this model refused them once: then it's asked again without.
    const where = `${connection.baseURL ?? OPENAI.baseURL} ${connection.model}`;
    const points = pointless.has(where) ? new Set<number>() : pointsOf(messages);
    const response = await request(points).catch((error) => {
      if (!points.size || !refusedPoints(error)) throw error;
      pointless.add(where);
      return request(new Set());
    });
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
              // Billed apart (at a premium) by the models that report it.
              cacheWrite: usage.input_tokens_details?.cache_write_tokens,
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
