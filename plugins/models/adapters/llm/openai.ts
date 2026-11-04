/**
 * OpenAI Responses API, streaming. A reasoning model's reasoning comes back
 * encrypted, as its answer's state, and goes back with its answer in the next
 * calls: between tool steps it carries on from it instead of thinking again.
 * So OpenAI keeps nothing (`store: false`): each call brings what it needs.
 */
import { alive, post, sse, usageOf } from "../../shared/provider.ts";
import { answerable, type LlmAdapter, type LlmFile, type LlmMessage } from "../../shared/types.ts";
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
 * A model's answer as it goes back to it (its state): the output's reasoning
 * items, encrypted, as they came but for their ids (which point at nothing
 * when nothing is stored), in their places among its message and its calls,
 * which stand in by kind (`{ type: "message" }`, `{ type: "function_call",
 * call_id }`).
 */
type Kept = { type: string; call_id?: string; [field: string]: unknown };

/**
 * An assistant message as input: its reasoning, text and calls in the order
 * they came out; without that order (no state, or another's), its text and then its calls.
 */
const answerOf = (message: Extract<LlmMessage, { role: "assistant" }>) => {
  const text: Record<string, unknown>[] = message.text
    ? [{ role: "assistant", content: message.text }]
    : [];
  const calls = new Map((message.toolCalls ?? []).map((call) => [call.id, {
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.input),
  }]));
  const kept = Array.isArray(message.state?.data) ? message.state.data as Kept[] : [];
  const input: Record<string, unknown>[] = [];
  for (const item of kept) {
    if (item.type === "message") input.push(...text.splice(0));
    else if (item.type === "function_call") {
      const call = calls.get(item.call_id ?? "");
      if (call) input.push(call);
      calls.delete(item.call_id ?? "");
    } else if (item.type === "reasoning") input.push(item);
  }
  return [...input, ...text, ...calls.values()];
};

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
    return answerOf(message);
  });

/** Models that refused breakpoints (OpenAI's before GPT-5.6, other servers): sent none from then on. */
const pointless = new Set<string>();

/** Servers that refused to send reasoning back encrypted: not asked again. */
const unreasoned = new Set<string>();

/** Servers that refused to be told not to store: not told again. */
const storing = new Set<string>();

/** Whether a refusal is of this part of the request, as its message names it. */
const refusedFor = (named: RegExp) => (error: unknown) =>
  (error as { status?: number }).status === 400 && named.test(String((error as Error).message));
const refusedPoints = refusedFor(/prompt_cache_breakpoint/);
// The parameter itself (`"param": "include"`, "Unrecognized … argument: include"), not what's in it.
const refusedInclude = refusedFor(/"param":\s*"include|['"]include['"]|argument[^.]*\binclude\b/i);
const refusedStore = refusedFor(/"param":\s*"store|['"]store['"]|argument[^.]*\bstore\b/i);

/** What's asked to come back with the answer: its reasoning, encrypted, to go back to it. */
const REASONING = ["reasoning.encrypted_content"];

export const openaiResponses: LlmAdapter = {
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
    const where = `${connection.baseURL ?? OPENAI.baseURL} ${connection.model}`;
    const asked = answerable(messages);
    // Breakpoints, its reasoning back (from a model that reasons), and nothing stored, unless this
    // server refused them once: then it's asked again without, from then on.
    let points = pointless.has(where) ? new Set<number>() : pointsOf(asked);
    let include = info?.reasoning !== false && !unreasoned.has(where);
    let unstored = !storing.has(where);
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
      ...(include ? { include: REASONING } : {}),
      ...(unstored ? { store: false } : {}),
      ...options,
    });
    let response: Response;
    for (;;) {
      try {
        response = await post(
          connection,
          OPENAI,
          "/responses",
          body(inputOf(asked, points)),
          signal,
        );
        break;
      } catch (error) {
        if (points.size && refusedPoints(error)) {
          pointless.add(where);
          points = new Set();
        } else if (include && refusedInclude(error)) {
          unreasoned.add(where);
          include = false;
        } else if (unstored && refusedStore(error)) {
          storing.add(where);
          unstored = false;
        } else throw error;
      }
    }
    // What goes back with the answer: its reasoning, in its place among what it wrote and called.
    const kept: Kept[] = [];
    // Thinking, it sends its reasoning's items for minutes before it writes: alive all the same.
    const beat = alive();
    for await (const { data } of sse(response.body!)) {
      const event = JSON.parse(data);
      if (beat()) yield { type: "thinking" };
      if (event.type === "response.output_text.delta") {
        yield { type: "text", text: event.delta };
      } else if (event.type === "response.output_item.done") {
        const item = event.item ?? {};
        if (item.type === "function_call") {
          kept.push({ type: "function_call", call_id: item.call_id });
          yield {
            type: "tool_call",
            call: {
              id: item.call_id,
              name: item.name,
              input: JSON.parse(item.arguments || "{}"),
            },
          };
        } else if (item.type === "message") kept.push({ type: "message" });
        else if (item.type === "reasoning") {
          const { id: _, status: __, ...reasoning } = item;
          kept.push(reasoning);
        }
      } else if (event.type === "response.completed") {
        const usage = event.response?.usage;
        // Sent back, its reasoning costs about what it took to think.
        const tokens = usage?.output_tokens_details?.reasoning_tokens;
        if (kept.some((item) => item.type === "reasoning")) {
          yield { type: "state", state: { data: kept, ...(tokens ? { tokens } : {}) } };
        }
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
