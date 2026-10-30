/** Anthropic Messages API, streaming. */
import { post, sse, usageOf } from "../../shared/provider.ts";
import type { ModelInfo } from "../../shared/choice.ts";
import type { Effort, LlmAdapter, LlmMessage, Usage } from "../../shared/types.ts";

export const ANTHROPIC = {
  name: "Anthropic",
  baseURL: "https://api.anthropic.com/v1",
  auth: (apiKey: string) => ({ "x-api-key": apiKey }),
  headers: { "anthropic-version": "2023-06-01" },
};

type Block = Record<string, unknown>;

/**
 * Anthropic alternates user and assistant turns; tool results are user
 * content. An assistant message's thinking (its state) goes first, as it
 * came. A message marked `cache` marks its last block as a cache point.
 */
const messagesOf = (messages: LlmMessage[]) => {
  const turns: { role: "user" | "assistant"; content: Block[] }[] = [];
  const points: (Block | undefined)[] = [];
  const add = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "tool") {
      add("user", [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.text,
      }]);
    } else if (message.role === "user") {
      add("user", [
        ...(message.text ? [{ type: "text", text: message.text }] : []),
        ...(message.files ?? []).map((file) => ({
          type: file.type === "application/pdf" ? "document" : "image",
          source: { type: "base64", media_type: file.type, data: file.data },
        })),
      ]);
    } else {
      add("assistant", [
        ...(Array.isArray(message.state?.data) ? message.state.data as Block[] : []),
        ...(message.text ? [{ type: "text", text: message.text }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ]);
    }
    if (message.cache) points.push(turns.at(-1)?.content.at(-1));
  }
  return { turns, points: points.filter((block): block is Block => Boolean(block)) };
};

const EPHEMERAL = { type: "ephemeral" };

/** Anthropic requires a limit: the model's, up to this, unless asked for more. */
const MAX_TOKENS = 32_000;

/** Thinking budgets for models that take one rather than an effort level. */
const BUDGETS: Record<Effort, number> = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 16_384,
  high: 32_768,
  xhigh: 49_152,
  max: 63_999,
};

/**
 * How hard to think, as the model takes it (the catalog says): an effort level
 * with adaptive thinking (and a model the catalog doesn't know), or a budget.
 */
function thinking(effort: Effort | undefined, info: ModelInfo | undefined, maxTokens?: number) {
  const limit = info?.output;
  const max = maxTokens ?? (limit ? Math.min(limit, MAX_TOKENS) : 8192);
  const reasoning = info?.reasoning;
  if (!effort || reasoning === false) return { max_tokens: max };
  if (reasoning?.budget && !reasoning.effort) {
    if (effort === "none") return { max_tokens: max };
    const { min = 1024, max: most = Infinity } = reasoning.budget;
    let budget = Math.min(Math.max(BUDGETS[effort], min), most);
    // The budget comes out of max_tokens.
    if (limit) budget = Math.min(budget, limit - 1);
    return {
      max_tokens: Math.min(Math.max(max, budget + 1), limit ?? Infinity),
      thinking: { type: "enabled", budget_tokens: budget },
    };
  }
  if (effort === "none") return { max_tokens: max, thinking: { type: "disabled" } };
  return {
    max_tokens: max,
    thinking: { type: "adaptive" },
    ...(reasoning?.effort || !reasoning ? { output_config: { effort } } : {}),
  };
}

export const anthropic: LlmAdapter = {
  media: ["image", "pdf"],
  async *generate(
    {
      connection,
      effort,
      maxTokens,
      temperature,
      options,
      info,
      instructions,
      messages,
      tools = [],
      signal,
    },
  ) {
    // Anthropic caches only up to marked blocks (at most 4): the tools, the
    // system text, the caller's cache points, and the end of the request, so
    // the next call finds this one's prefix.
    const { turns, points } = messagesOf(messages);
    const last = turns.at(-1)?.content.at(-1);
    for (const block of [...points.slice(-1), last]) if (block) block.cache_control = EPHEMERAL;
    const response = await post(connection, ANTHROPIC, "/messages", {
      model: connection.model,
      ...thinking(effort, info, maxTokens),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(instructions
        ? { system: [{ type: "text", text: instructions, cache_control: EPHEMERAL }] }
        : {}),
      messages: turns,
      ...(tools.length
        ? {
          tools: tools.map((tool, i) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input,
            ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
          })),
        }
        : {}),
      stream: true,
      ...options,
    }, signal);
    // Tool input arrives as JSON in pieces, per content block; so does thinking, with its signature.
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    const thoughts = new Map<number, Block>();
    let usage: Usage = { input: 0, output: 0 };
    for await (const { data } of sse(response.body!)) {
      const event = JSON.parse(data);
      switch (event.type) {
        case "message_start": {
          // Anthropic's input_tokens excludes what was read from or written to the cache.
          const u = event.message?.usage ?? {};
          usage = {
            input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
            output: u.output_tokens ?? 0,
            cached: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
          };
          break;
        }
        case "content_block_start":
          if (
            event.content_block?.type === "thinking" ||
            event.content_block?.type === "redacted_thinking"
          ) {
            thoughts.set(event.index, { ...event.content_block });
          } else if (event.content_block?.type === "tool_use") {
            blocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
          }
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta") {
            const block = blocks.get(event.index);
            if (block) block.json += event.delta.partial_json ?? "";
          } else if (event.delta?.type === "thinking_delta") {
            const thought = thoughts.get(event.index);
            if (thought) {
              thought.thinking = `${thought.thinking ?? ""}${event.delta.thinking ?? ""}`;
            }
          } else if (event.delta?.type === "signature_delta") {
            const thought = thoughts.get(event.index);
            if (thought) {
              thought.signature = `${thought.signature ?? ""}${event.delta.signature ?? ""}`;
            }
          }
          break;
        case "content_block_stop": {
          const block = blocks.get(event.index);
          if (block) {
            blocks.delete(event.index);
            yield {
              type: "tool_call",
              call: { id: block.id, name: block.name, input: JSON.parse(block.json || "{}") },
            };
          }
          break;
        }
        case "message_delta":
          usage.output = event.usage?.output_tokens ?? usage.output;
          break;
        case "message_stop":
          // Its thinking goes back with this answer when tools continue it.
          if (thoughts.size) {
            yield {
              type: "state",
              state: { data: [...thoughts].sort(([a], [b]) => a - b).map(([, t]) => t) },
            };
          }
          yield { type: "usage", ...usageOf(usage) };
          break;
        case "error":
          throw new Error(`Anthropic: ${event.error?.message ?? JSON.stringify(event.error)}`);
      }
    }
  },
};
