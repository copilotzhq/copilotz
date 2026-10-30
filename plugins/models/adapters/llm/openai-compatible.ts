/**
 * OpenAI Chat Completions, streaming: the `openai-compatible` protocol. Most
 * providers speak it (DeepSeek, Groq, Together, OpenRouter, Ollama…); the
 * catalog knows their URLs, or `baseURL` points at one.
 */
import { post, sse, usageOf } from "../../shared/provider.ts";
import type { LlmAdapter, LlmMessage } from "../../shared/types.ts";

export const OPENAI = {
  name: "OpenAI",
  baseURL: "https://api.openai.com/v1",
  auth: (apiKey: string) => ({ authorization: `Bearer ${apiKey}` }),
};

const messagesOf = (instructions: string | undefined, messages: LlmMessage[]) => [
  ...(instructions ? [{ role: "system", content: instructions }] : []),
  ...messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.text };
    }
    if (message.role === "user") {
      if (!message.files?.length) return { role: "user", content: message.text };
      return {
        role: "user",
        content: [
          { type: "text", text: message.text },
          ...message.files.map((file) => ({
            type: "image_url",
            image_url: { url: `data:${file.type};base64,${file.data}` },
          })),
        ],
      };
    }
    return {
      role: "assistant",
      content: message.text || null,
      ...(message.toolCalls?.length
        ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }
        : {}),
    };
  }),
];

export const openaiCompletions: LlmAdapter = {
  // Images: what providers speaking it take alike.
  media: ["image"],
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
    // OpenAI's own endpoint wants max_completion_tokens; the others know max_tokens.
    const own = (connection.baseURL ?? OPENAI.baseURL).startsWith(OPENAI.baseURL);
    const response = await post(connection, OPENAI, "/chat/completions", {
      model: connection.model,
      messages: messagesOf(instructions, messages),
      ...(tools.length
        ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.input },
          })),
        }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(maxTokens ? { [own ? "max_completion_tokens" : "max_tokens"]: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...options,
    }, signal);
    // Tool calls arrive in pieces, by index; they are complete when the stream ends.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const { data } of sse(response.body!)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data);
      if (chunk.error) {
        throw new Error(`OpenAI: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: "text", text: delta.content };
        for (const part of delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(part.index, call);
        }
      }
      if (chunk.usage) {
        yield {
          type: "usage",
          ...usageOf({
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            cached: chunk.usage.prompt_tokens_details?.cached_tokens,
            reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
          }),
        };
      }
    }
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      yield {
        type: "tool_call",
        call: {
          id: call.id || crypto.randomUUID(),
          name: call.name,
          input: JSON.parse(call.args || "{}"),
        },
      };
    }
  },
};
