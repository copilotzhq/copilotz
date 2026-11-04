/**
 * Every provider adapter, against a local server speaking that provider's
 * API: the request (base URL, auth from `apiKey`, custom headers that add and
 * override, body translation including tool calls and results) and the
 * streamed answer (text, tool calls assembled from pieces, usage).
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, {
  type LlmAdapter,
  type LlmChunk,
  type LlmMessage,
  type LlmRequest,
} from "../mod.ts";
import { anthropic } from "../adapters/llm/anthropic.ts";
import { gemini, schemaFor } from "../adapters/llm/gemini.ts";
import { openaiCompletions } from "../adapters/llm/openai-compatible.ts";
import { openaiResponses } from "../adapters/llm/openai.ts";
import { serve, test } from "../../../testing/mod.ts";

type Seen = { path: string; headers: Headers; body: unknown; form?: FormData; raw?: string };

const sse = (events: unknown[], named = false) =>
  events.map((e) =>
    (named ? `event: ${(e as { type: string }).type}\n` : "") +
    `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`
  ).join("");

/** An Anthropic stream that says its counts in `message_start` and in `message_delta`. */
const counted = (start: Record<string, number>, delta: Record<string, number>) => () =>
  new Response(sse([
    { type: "message_start", message: { usage: start } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: delta },
    { type: "message_stop" },
  ], true));

/** A provider stand-in: records each request and answers by path. */
async function server() {
  const seen: Seen[] = [];
  const replies: Record<string, () => Response> = {
    "/v1/chat/completions": () =>
      new Response(sse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "roll", arguments: '{"si' } }],
            },
          }],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'des":6}' } }] } }],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 8 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        },
        "[DONE]",
      ])),
    "/v1/responses": () =>
      new Response(sse([
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "c1", name: "roll", arguments: '{"sides":6}' },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              input_tokens_details: { cached_tokens: 8 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ], true)),
    "/anthropic/v1/messages": () =>
      new Response(sse([
        // Anthropic counts cache reads and writes apart from input_tokens.
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 1,
              cache_read_input_tokens: 8,
              cache_creation_input_tokens: 2,
              output_tokens: 1,
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "c1", name: "roll", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"si' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: 'des":6}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ], true)),
    // MiniMax, speaking Anthropic's protocol: its input and cache reads only at the end.
    "/minimax/v1/messages": counted({ input_tokens: 0, output_tokens: 0 }, {
      input_tokens: 3,
      cache_read_input_tokens: 8,
      output_tokens: 7,
    }),
    // Anthropic saying its counts at the start, and again as totals at the end.
    "/totals/v1/messages": counted(
      {
        input_tokens: 1,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
        output_tokens: 1,
      },
      {
        input_tokens: 1,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
        output_tokens: 7,
      },
    ),
    "/gemini/v1beta/models/flash:streamGenerateContent": () =>
      new Response(sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
        {
          candidates: [{
            content: {
              role: "model",
              parts: [{ functionCall: { name: "roll", args: { sides: 6 } } }],
            },
          }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 2,
            cachedContentTokenCount: 8,
          },
        },
      ])),
    "/v1/embeddings": () =>
      Response.json({
        data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
        usage: { prompt_tokens: 4 },
      }),
    "/v1/audio/transcriptions": () =>
      Response.json({ text: "hello there", usage: { type: "duration", seconds: 3 } }),
    "/v1/fail/chat/completions": () => new Response("nope", { status: 401 }),
    // A model that says its thinking (DeepSeek's `reasoning_content`), before what it calls.
    "/v1/thinking/chat/completions": () =>
      new Response(sse([
        { choices: [{ delta: { reasoning_content: "Two dice? " } }] },
        { choices: [{ delta: { reasoning_content: "One." } }] },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "roll", arguments: "{}" } }],
            },
          }],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        },
        "[DONE]",
      ])),
    // A model thinking: only its reasoning's items, before it writes.
    "/v1/thinking/responses": () =>
      new Response(sse([
        { type: "response.created" },
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: { id: "rs_1", type: "reasoning", encrypted_content: "E1", summary: [] },
        },
        { type: "response.output_text.delta", delta: "Done." },
        { type: "response.completed", response: {} },
      ], true)),
    // A reasoning model: its reasoning, encrypted, before and between what it writes and calls.
    "/v1/reasoning/responses": () =>
      new Response(sse([
        {
          type: "response.output_item.done",
          item: { id: "rs_1", type: "reasoning", encrypted_content: "E1", summary: [] },
        },
        { type: "response.output_text.delta", delta: "Rolling." },
        {
          type: "response.output_item.done",
          item: { id: "msg_1", type: "message", status: "completed", content: [] },
        },
        {
          type: "response.output_item.done",
          item: { id: "rs_2", type: "reasoning", encrypted_content: "E2", summary: [] },
        },
        {
          type: "response.output_item.done",
          item: {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            call_id: "c1",
            name: "roll",
            arguments: '{"sides":6}',
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        },
      ], true)),
  };
  // A server whose model takes no cache breakpoints (OpenAI's before GPT-5.6), and that reports
  // what it wrote to the cache otherwise.
  const pointless = (body: string) =>
    body.includes("prompt_cache_breakpoint")
      ? Response.json({
        error: {
          message: "prompt_cache_breakpoint is not supported on this model",
          param: "prompt_cache_breakpoint",
          code: "invalid_parameter",
        },
      }, { status: 400 })
      : new Response(sse([
        { type: "response.output_text.delta", delta: "Hi" },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 11,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 6, cache_write_tokens: 3 },
            },
          },
        },
      ], true));
  // A server that doesn't know `include` (one speaking the Responses protocol, not OpenAI).
  const unreasoned = (body: string) =>
    JSON.parse(body).include
      ? Response.json({
        error: { message: "Unknown parameter: 'include'.", param: "include", code: "unknown" },
      }, { status: 400 })
      : new Response(sse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
      ], true));
  // A server that doesn't know `store`.
  const storing = (body: string) =>
    "store" in JSON.parse(body)
      ? Response.json({
        error: { message: "Unknown parameter: 'store'.", param: "store", code: "unknown" },
      }, { status: 400 })
      : new Response(sse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
      ], true));
  const http = await serve(async (request) => {
    const url = new URL(request.url);
    const multipart = request.headers.get("content-type")?.startsWith("multipart/");
    // As sent: a runtime's parser may guess a part's type from its name (Bun's does).
    const raw = multipart ? await request.clone().text() : undefined;
    const form = multipart ? await request.formData() : undefined;
    const text = form ? "" : await request.text();
    seen.push({
      path: url.pathname + url.search,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
      form,
      raw,
    });
    if (url.pathname === "/v1/pointless/responses") return pointless(text);
    if (url.pathname === "/v1/unreasoned/responses") return unreasoned(text);
    if (url.pathname === "/v1/storing/responses") return storing(text);
    return (replies[url.pathname] ?? (() => new Response("unknown", { status: 404 })))();
  });
  return { url: http.url, seen, close: () => http.close() };
}

const conversation: LlmMessage[] = [
  { role: "user", text: "roll a die" },
  {
    role: "assistant",
    text: "Rolling.",
    toolCalls: [{ id: "c0", name: "roll", input: { sides: 6 } }],
  },
  // A cache point: providers that cache where told (Anthropic, OpenAI's newer models) mark it.
  { role: "tool", toolCallId: "c0", text: "4", cache: true },
  { role: "user", text: "again" },
];
const tools = [{
  name: "roll",
  description: "Roll a die.",
  input: {
    type: "object",
    properties: { sides: { type: "integer" } },
    additionalProperties: false,
  } as const,
}];

async function run(
  adapter: LlmAdapter,
  connection: LlmRequest["connection"],
  settings: Omit<LlmRequest, "connection" | "messages"> & { messages?: LlmMessage[] } = {},
) {
  const chunks: LlmChunk[] = [];
  for await (
    const chunk of adapter.generate({
      connection,
      instructions: "Be brief.",
      messages: conversation,
      tools,
      ...settings,
    })
  ) chunks.push(chunk);
  return chunks;
}

const answer = (chunks: LlmChunk[]) => ({
  text: chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""),
  calls: chunks.filter((c) => c.type === "tool_call").map((c) => (c as { call: unknown }).call),
  usage: chunks.find((c) => c.type === "usage"),
});

const expected = {
  text: "Hello",
  calls: [{ id: "c1", name: "roll", input: { sides: 6 } }],
  // Every input token, 8 of them read from the provider's cache; 2 of the output tokens reasoning.
  usage: { type: "usage" as const, input: 11, output: 7, cached: 8, reasoning: 2 },
};

test("openai-compatible (Chat Completions): request and streamed answer", async () => {
  const mock = await server();
  try {
    const chunks = await run(openaiCompletions, {
      model: "m",
      baseURL: `${mock.url}/v1`,
      apiKey: "k",
      headers: { "x-extra": "1" },
    }, { temperature: 0 });
    assertEquals(answer(chunks), expected);
    const [req] = mock.seen;
    assertEquals(req.path, "/v1/chat/completions");
    assertEquals(req.headers.get("authorization"), "Bearer k");
    assertEquals(req.headers.get("x-extra"), "1");
    const body = req.body as Record<string, unknown>;
    assertEquals(body.temperature, 0);
    assertEquals(body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "roll a die" },
      {
        role: "assistant",
        content: "Rolling.",
        tool_calls: [{
          id: "c0",
          type: "function",
          function: { name: "roll", arguments: '{"sides":6}' },
        }],
      },
      { role: "tool", tool_call_id: "c0", content: "4" },
      { role: "user", content: "again" },
    ]);
    assertEquals((body.tools as { function: { name: string } }[])[0].function.name, "roll");
  } finally {
    await mock.close();
  }
});

test("openai-compatible: what a model thinks comes back as state, and goes back with its answer", async () => {
  const mock = await server();
  try {
    const connection = { model: "m", baseURL: `${mock.url}/v1/thinking`, apiKey: "k" };
    const chunks: LlmChunk[] = [];
    for await (
      const chunk of openaiCompletions.generate({ connection, messages: conversation, tools })
    ) chunks.push(chunk);
    assertEquals(chunks.filter((c) => c.type === "state"), [
      { type: "state", state: { data: { reasoning_content: "Two dice? One." }, tokens: 3 } },
    ]);
    assertEquals(answer(chunks).calls, [{ id: "c1", name: "roll", input: {} }]);
    // Its next call: the thinking goes back on the answer it came with; none on one without.
    const [first, ...rest] = conversation;
    for await (
      const _ of openaiCompletions.generate({
        connection,
        messages: [
          first,
          { role: "assistant", text: "Hm.", state: { data: { other: true } } },
          { role: "user", text: "and?" },
          {
            role: "assistant",
            toolCalls: [{ id: "c1", name: "roll", input: {} }],
            state: { by: "deepseek/m", data: { reasoning_content: "Two dice? One." } },
          },
          { role: "tool", toolCallId: "c1", text: "3" },
          ...rest.slice(-1),
        ],
        tools,
      })
    );
    const sent = (mock.seen.at(-1)!.body as { messages: Record<string, unknown>[] }).messages;
    assertEquals(sent[1], { role: "assistant", content: "Hm." });
    assertEquals(sent[3].reasoning_content, "Two dice? One.");
    assertEquals(sent[3].content, null);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): a model thinking before it writes says it's at work", async () => {
  const mock = await server();
  try {
    const chunks = await run(openaiResponses, {
      model: "m",
      baseURL: `${mock.url}/v1/thinking`,
      apiKey: "k",
    }, { effort: "xhigh" });
    // At work before its first word (once: at most about once a second), then what it wrote.
    assertEquals(chunks.slice(0, 2), [{ type: "thinking" }, { type: "text", text: "Done." }]);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): request and streamed answer", async () => {
  const mock = await server();
  try {
    const chunks = await run(openaiResponses, {
      model: "m",
      baseURL: `${mock.url}/v1/`,
      apiKey: "k",
    });
    assertEquals(answer(chunks), expected);
    const [req] = mock.seen;
    assertEquals(req.path, "/v1/responses");
    const body = req.body as Record<string, unknown>;
    assertEquals(body.instructions, "Be brief.");
    // Nothing kept at OpenAI: what a call needs (its reasoning too) comes with it.
    assertEquals(body.store, false);
    assertEquals(body.input, [
      { role: "user", content: "roll a die" },
      { role: "assistant", content: "Rolling." },
      { type: "function_call", call_id: "c0", name: "roll", arguments: '{"sides":6}' },
      // The cache point: a breakpoint, so the next call finds this prefix.
      {
        type: "function_call_output",
        call_id: "c0",
        output: [{
          type: "input_text",
          text: "4",
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
      { role: "user", content: "again" },
    ]);
    // Not strict: optional fields stay optional.
    assertEquals(
      (body.tools as { name: string; strict: boolean }[]).map((t) => [t.name, t.strict]),
      [
        ["roll", false],
      ],
    );
  } finally {
    await mock.close();
  }
});

test("openai (Responses): a model that takes no breakpoints is asked again without, from then on", async () => {
  const mock = await server();
  try {
    const connection = { model: "old", baseURL: `${mock.url}/v1/pointless`, apiKey: "k" };
    const chunks = await run(openaiResponses, connection);
    // What it wrote to the cache is counted apart.
    assertEquals(answer(chunks).usage, {
      type: "usage",
      input: 11,
      output: 2,
      cached: 6,
      cacheWrite: 3,
    });
    await run(openaiResponses, connection);
    const marked = mock.seen.map((s) => JSON.stringify(s.body).includes("prompt_cache_breakpoint"));
    assertEquals(marked, [true, false, false]);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): a cache point on the model's own message goes on the input before it", async () => {
  const mock = await server();
  try {
    const messages: LlmMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello.", cache: true },
    ];
    for await (
      const _ of openaiResponses.generate({
        connection: { model: "m", baseURL: `${mock.url}/v1/`, apiKey: "k" },
        messages,
      })
    ) { /* drained */ }
    assertEquals((mock.seen[0].body as { input: unknown[] }).input, [
      {
        role: "user",
        content: [{
          type: "input_text",
          text: "hi",
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
      { role: "assistant", content: "Hello." },
      // What it's asked for is its next message, not the rest of this one.
      { role: "user", content: "Continue." },
    ]);
  } finally {
    await mock.close();
  }
});

/** What the Responses adapter sends for these messages (and the info given). */
async function responsesInput(
  baseURL: string,
  messages: LlmMessage[],
  info?: LlmRequest["info"],
) {
  const mock = await server();
  try {
    for await (
      const _ of openaiResponses.generate({
        connection: { model: "m", baseURL: `${mock.url}${baseURL}`, apiKey: "k" },
        messages,
        ...(info ? { info } : {}),
      })
    ) { /* the request is what's checked */ }
    return mock.seen[0].body as { input: unknown[]; include?: string[] };
  } finally {
    await mock.close();
  }
}

/** A reasoning model's answer, as the adapter keeps it: reasoning in its place among the rest. */
const reasoned = [
  { type: "reasoning", encrypted_content: "E1", summary: [] },
  { type: "message" },
  { type: "reasoning", encrypted_content: "E2", summary: [] },
  { type: "function_call", call_id: "c1" },
];

test("openai (Responses): a reasoning model's reasoning comes back as state, in its place, without ids", async () => {
  const mock = await server();
  try {
    const chunks = await run(openaiResponses, {
      model: "m",
      baseURL: `${mock.url}/v1/reasoning`,
      apiKey: "k",
    });
    assertEquals(answer(chunks).text, "Rolling.");
    assertEquals(answer(chunks).calls, [{ id: "c1", name: "roll", input: { sides: 6 } }]);
    assertEquals(chunks.filter((c) => c.type === "state"), [{
      type: "state",
      // Sent back, it costs about what it took to think.
      state: { data: reasoned, tokens: 5 },
    }]);
    // Asked for, encrypted: nothing is kept on OpenAI's side for it to point at.
    assertEquals((mock.seen[0].body as { include: string[] }).include, [
      "reasoning.encrypted_content",
    ]);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): its reasoning goes back with its answer, in order; breakpoints stay where they were", async () => {
  const body = await responsesInput("/v1/", [
    { role: "user", text: "roll a die" },
    {
      role: "assistant",
      text: "Rolling.",
      toolCalls: [{ id: "c1", name: "roll", input: { sides: 6 } }],
      state: { by: "openai/m", data: reasoned },
    },
    { role: "tool", toolCallId: "c1", text: "4", cache: true },
    { role: "user", text: "again" },
  ]);
  assertEquals(body.input, [
    { role: "user", content: "roll a die" },
    { type: "reasoning", encrypted_content: "E1", summary: [] },
    { role: "assistant", content: "Rolling." },
    { type: "reasoning", encrypted_content: "E2", summary: [] },
    { type: "function_call", call_id: "c1", name: "roll", arguments: '{"sides":6}' },
    {
      type: "function_call_output",
      call_id: "c1",
      output: [{ type: "input_text", text: "4", prompt_cache_breakpoint: { mode: "explicit" } }],
    },
    { role: "user", content: "again" },
  ]);
});

test("openai (Responses): a final answer's reasoning goes back with it; an empty one's alone", async () => {
  const thought = { type: "reasoning", encrypted_content: "E1", summary: [] };
  const body = await responsesInput("/v1/", [
    { role: "user", text: "closest to 2026?" },
    { role: "assistant", text: "43 and 47.", state: { data: [thought, { type: "message" }] } },
    { role: "user", text: "and 3000?" },
    // An answer with no text: its reasoning still goes back (the API takes it alone).
    { role: "assistant", text: "", state: { data: [thought] } },
    // Without state, an empty answer sends nothing, as before.
    { role: "assistant", text: "" },
    { role: "user", text: "well?" },
  ]);
  assertEquals(body.input, [
    { role: "user", content: "closest to 2026?" },
    thought,
    { role: "assistant", content: "43 and 47." },
    { role: "user", content: "and 3000?" },
    thought,
    { role: "user", content: "well?" },
  ]);
});

test("openai (Responses): state that doesn't place the text and calls puts its reasoning first", async () => {
  const thought = { type: "reasoning", encrypted_content: "E1", summary: [] };
  const body = await responsesInput("/v1/", [
    { role: "user", text: "roll" },
    {
      role: "assistant",
      text: "Rolling.",
      toolCalls: [{ id: "c1", name: "roll", input: {} }],
      state: { data: [thought] },
    },
    { role: "tool", toolCallId: "c1", text: "4" },
  ]);
  assertEquals(body.input, [
    { role: "user", content: "roll" },
    thought,
    { role: "assistant", content: "Rolling." },
    { type: "function_call", call_id: "c1", name: "roll", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "4" },
  ]);
});

test("openai (Responses): a model that doesn't reason isn't asked for its reasoning, and keeps no state", async () => {
  const mock = await server();
  try {
    const chunks = await run(openaiResponses, {
      model: "m",
      baseURL: `${mock.url}/v1/`,
      apiKey: "k",
    }, { info: { reasoning: false } });
    assertEquals(chunks.filter((c) => c.type === "state"), []);
    assertEquals((mock.seen[0].body as { include?: string[] }).include, undefined);
    // One the catalog doesn't rule out is asked; an answer that came without reasoning keeps none.
    const asked = await run(openaiResponses, {
      model: "m",
      baseURL: `${mock.url}/v1/`,
      apiKey: "k",
    });
    assertEquals(asked.filter((c) => c.type === "state"), []);
    assertEquals((mock.seen[1].body as { include?: string[] }).include, [
      "reasoning.encrypted_content",
    ]);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): a server that refuses `include` is asked again without, from then on", async () => {
  const mock = await server();
  try {
    const connection = { model: "m", baseURL: `${mock.url}/v1/unreasoned`, apiKey: "k" };
    assertEquals(answer(await run(openaiResponses, connection)).text, "Hi");
    await run(openaiResponses, connection);
    assertEquals(mock.seen.map((s) => (s.body as { include?: string[] }).include !== undefined), [
      true,
      false,
      false,
    ]);
  } finally {
    await mock.close();
  }
});

test("openai (Responses): a server that refuses `store` is asked again without, from then on", async () => {
  const mock = await server();
  try {
    const connection = { model: "m", baseURL: `${mock.url}/v1/storing`, apiKey: "k" };
    assertEquals(answer(await run(openaiResponses, connection)).text, "Hi");
    await run(openaiResponses, connection);
    const bodies = mock.seen.map((s) => s.body as { store?: boolean; include?: string[] });
    assertEquals(bodies.map((b) => b.store), [false, undefined, undefined]);
    // Its reasoning is still asked for.
    assertEquals(bodies.map((b) => b.include !== undefined), [true, true, true]);
  } finally {
    await mock.close();
  }
});

test("anthropic: request and streamed answer", async () => {
  const mock = await server();
  try {
    const chunks = await run(anthropic, {
      model: "claude",
      baseURL: `${mock.url}/anthropic/v1`,
      apiKey: "k",
    });
    // Anthropic reports what it wrote to the cache too, and no reasoning count.
    assertEquals(answer(chunks), {
      ...expected,
      usage: { type: "usage", input: 11, output: 7, cached: 8, cacheWrite: 2 },
    });
    const [req] = mock.seen;
    assertEquals(req.path, "/anthropic/v1/messages");
    assertEquals(req.headers.get("x-api-key"), "k");
    assertEquals(req.headers.get("anthropic-version"), "2023-06-01");
    const body = req.body as Record<string, unknown>;
    // Cache points: the system text, the last tool, a message marked `cache`, the request's end.
    const cache = { type: "ephemeral" };
    assertEquals(body.system, [{ type: "text", text: "Be brief.", cache_control: cache }]);
    assertEquals(body.messages, [
      { role: "user", content: [{ type: "text", text: "roll a die" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Rolling." },
          { type: "tool_use", id: "c0", name: "roll", input: { sides: 6 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c0", content: "4", cache_control: cache },
          { type: "text", text: "again", cache_control: cache },
        ],
      },
    ]);
    const sent = body.tools as { input_schema: unknown; cache_control?: unknown }[];
    assertEquals(sent[0].input_schema, tools[0].input);
    assertEquals(sent.at(-1)!.cache_control, cache);
  } finally {
    await mock.close();
  }
});

test("anthropic: what it used counts once, said at the start, the end, or both", async () => {
  const mock = await server();
  try {
    const usage = async (path: string) =>
      answer(await run(anthropic, { model: "m", baseURL: `${mock.url}${path}`, apiKey: "k" }))
        .usage;
    assertEquals(await usage("/minimax/v1"), { type: "usage", input: 11, output: 7, cached: 8 });
    assertEquals(await usage("/totals/v1"), {
      type: "usage",
      input: 11,
      output: 7,
      cached: 8,
      cacheWrite: 2,
    });
  } finally {
    await mock.close();
  }
});

test("every adapter asks for the model's next message, never the rest of its last", async () => {
  const mock = await server();
  try {
    // An answer came after what it now answers: the conversation ends with its own message.
    const messages: LlmMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello." },
    ];
    const at = (path: string, model = "m") => ({
      model,
      baseURL: `${mock.url}${path}`,
      apiKey: "k",
    });
    await run(anthropic, at("/anthropic/v1", "claude"), { messages });
    await run(gemini, at("/gemini/v1beta", "flash"), { messages });
    await run(openaiCompletions, at("/v1"), { messages });
    await run(openaiResponses, at("/v1"), { messages });
    const [claude, flash, completions, responses] = mock.seen.map((s) =>
      s.body as Record<string, unknown[]>
    );
    // Anthropic's newer models refuse an assistant message last ("prefill"): a user turn follows.
    assertEquals(claude.messages.slice(-2), [
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
      {
        role: "user",
        content: [{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }],
      },
    ]);
    assertEquals(flash.contents.slice(-2), [
      { role: "model", parts: [{ text: "Hello." }] },
      { role: "user", parts: [{ text: "Continue." }] },
    ]);
    assertEquals(completions.messages.slice(-2), [
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Continue." },
    ]);
    assertEquals(responses.input.slice(-2), [
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Continue." },
    ]);
  } finally {
    await mock.close();
  }
});

test("gemini: request and streamed answer", async () => {
  const mock = await server();
  try {
    const chunks = await run(gemini, {
      model: "flash",
      baseURL: `${mock.url}/gemini/v1beta`,
      apiKey: "k",
    });
    const got = answer(chunks);
    assertEquals([got.text, got.usage], [expected.text, expected.usage]);
    // Gemini calls carry no id; one is made up so the result can refer to it.
    assertEquals((got.calls as { name: string; input: unknown }[]).map((c) => [c.name, c.input]), [[
      "roll",
      { sides: 6 },
    ]]);
    const [req] = mock.seen;
    assertEquals(req.path, "/gemini/v1beta/models/flash:streamGenerateContent?alt=sse");
    assertEquals(req.headers.get("x-goog-api-key"), "k");
    const body = req.body as Record<string, unknown>;
    assertEquals(body.systemInstruction, { parts: [{ text: "Be brief." }] });
    assertEquals(body.contents, [
      { role: "user", parts: [{ text: "roll a die" }] },
      {
        role: "model",
        parts: [{ text: "Rolling." }, { functionCall: { name: "roll", args: { sides: 6 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "roll", response: { result: "4" } } }, {
          text: "again",
        }],
      },
    ]);
    assertEquals(body.tools, [{
      functionDeclarations: [{
        name: "roll",
        description: "Roll a die.",
        parameters: { type: "object", properties: { sides: { type: "integer" } } },
      }],
    }]);
  } finally {
    await mock.close();
  }
});

test("gemini: JSON Schema is narrowed to what Gemini accepts", () => {
  assertEquals(
    schemaFor({
      $schema: "x",
      type: "object",
      additionalProperties: false,
      properties: {
        a: { type: ["string", "null"], default: "x" },
        b: { type: "array", items: { type: "number", examples: [1] } },
      },
    }),
    {
      type: "object",
      properties: {
        a: { type: "string", nullable: true },
        b: { type: "array", items: { type: "number" } },
      },
    },
  );
});

test("files go with a message as each provider takes them", async () => {
  const image = { name: "a.png", type: "image/png", data: "iVBO" };
  const pdf = { name: "b.pdf", type: "application/pdf", data: "JVBE" };
  const looked: LlmMessage[] = [{ role: "user", text: "look", files: [image, pdf] }];
  const mock = await server();
  const sent = async (adapter: LlmAdapter, model: string, baseURL: string) => {
    mock.seen.length = 0;
    for await (
      const _ of adapter.generate({
        connection: { model, baseURL: `${mock.url}${baseURL}`, apiKey: "k" },
        messages: looked,
      })
    ) { /* the request is what's checked */ }
    return mock.seen[0].body as Record<string, unknown>;
  };
  try {
    assertEquals((await sent(openaiResponses, "m", "/v1/")).input, [{
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,iVBO" },
        { type: "input_file", filename: "b.pdf", file_data: "data:application/pdf;base64,JVBE" },
      ],
    }]);
    assertEquals((await sent(openaiCompletions, "m", "/v1/")).messages, [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBO" } },
        { type: "image_url", image_url: { url: "data:application/pdf;base64,JVBE" } },
      ],
    }]);
    assertEquals((await sent(anthropic, "m", "/anthropic/v1/")).messages, [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "JVBE" },
          // The last block of the prompt: Anthropic's cache point.
          cache_control: { type: "ephemeral" },
        },
      ],
    }]);
    assertEquals((await sent(gemini, "flash", "/gemini/v1beta")).contents, [{
      role: "user",
      parts: [
        { text: "look" },
        { inlineData: { mimeType: "image/png", data: "iVBO" } },
        { inlineData: { mimeType: "application/pdf", data: "JVBE" } },
      ],
    }]);
    // What each sends: the models plugin gives an adapter only these.
    assertEquals(
      [openaiResponses, openaiCompletions, anthropic, gemini].map((a) => a.media),
      [["image", "pdf"], ["image"], ["image", "pdf"], ["image", "pdf", "audio", "video"]],
    );
  } finally {
    await mock.close();
  }
});

test("headers replace the default auth, so any gateway or auth scheme works", async () => {
  const mock = await server();
  try {
    await run(openaiCompletions, {
      model: "m",
      baseURL: `${mock.url}/v1`,
      apiKey: "k",
      headers: { authorization: "Bearer gateway-token", "api-key": "azure-style" },
    });
    await run(anthropic, {
      model: "claude",
      baseURL: `${mock.url}/anthropic/v1`,
      headers: { authorization: "Bearer proxy", "anthropic-version": "2024-01-01" },
    });
    const [openai, claude] = mock.seen;
    assertEquals(openai.headers.get("authorization"), "Bearer gateway-token");
    assertEquals(openai.headers.get("api-key"), "azure-style");
    // No apiKey: no x-api-key; the custom headers carry auth instead.
    assertEquals(claude.headers.get("x-api-key"), null);
    assertEquals(claude.headers.get("authorization"), "Bearer proxy");
    assertEquals(claude.headers.get("anthropic-version"), "2024-01-01");
  } finally {
    await mock.close();
  }
});

test("a provider error names the provider and status", async () => {
  const mock = await server();
  try {
    const error = await assertRejects(() =>
      run(openaiCompletions, {
        model: "m",
        baseURL: `${mock.url}/v1/fail`,
      })
    );
    assertEquals((error as Error).message, "OpenAI 401: nope");
    assertEquals((error as { status?: number }).status, 401);
  } finally {
    await mock.close();
  }
});

test("llm, embeddings and transcription actions, through the runtime", async () => {
  const mock = await server();
  const app = definePlugin({
    name: "app",
    resources: {
      // An endpoint of our own: it names its protocol and where it is.
      provider: { mock: { adapter: "openai-compatible", baseURL: `${mock.url}/v1`, apiKey: "k" } },
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, app],
  });
  try {
    const frames: unknown[] = [];
    runtime.subscribe((item) => item.kind === "frame" && frames.push(item.data));
    const completion = await runtime.call("llm.generate", {
      model: "mock/m",
      messages: [{ role: "user", text: "hi" }],
      stream: "demo",
    });
    assertEquals(completion, {
      text: "Hello",
      toolCalls: [{ id: "c1", name: "roll", input: { sides: 6 } }],
      usage: { model: "mock/m", input: 11, output: 7, cached: 8, reasoning: 2 },
    });
    assertEquals(frames.filter((f) => (f as { type: string }).type === "delta"), [
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
    ]);
    assertEquals(
      await runtime.call("embeddings.embed", {
        model: { model: "mock/e", dimensions: 2 },
        input: ["a", "b"],
      }),
      { vectors: [[1, 0], [0, 1]], usage: { input: 4, output: 0, model: "mock/e" } },
    );
    const embedRequest = mock.seen.find((s) => s.path === "/v1/embeddings")!;
    assertEquals(embedRequest.body, { model: "e", input: ["a", "b"], dimensions: 2 });
    const audio = btoa(String.fromCharCode(1, 2, 3));
    assertEquals(
      await runtime.call("transcription.transcribe", {
        model: "mock/t",
        audio,
        type: "audio/webm;codecs=opus",
        language: "pt",
      }),
      // Billed by audio length.
      { text: "hello there", usage: { input: 0, output: 0, seconds: 3, model: "mock/t" } },
    );
    const sent = mock.seen.find((s) => s.path === "/v1/audio/transcriptions")!;
    const file = sent.form!.get("file") as File;
    assertEquals([file.name, file.size], ["audio.webm", 3]);
    assertStringIncludes(sent.raw!, "Content-Type: audio/webm\r\n");
    assertEquals([sent.form!.get("model"), sent.form!.get("language")], ["t", "pt"]);
    assertEquals(sent.headers.get("authorization"), "Bearer k");
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("openai-compatible: each provider's way of saying what came from the cache, or went to it", async () => {
  // As DeepSeek, Moonshot and OpenRouter (an explicit cache, written) report it.
  const usages = [
    [{ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }, { cached: 60 }],
    [{ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 40 }, { cached: 40 }],
    [
      {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 90 },
      },
      { cacheWrite: 90 },
    ],
  ] as const;
  for (const [usage, cache] of usages) {
    const http = await serve(() =>
      new Response(
        sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [], usage }, "[DONE]"]),
      )
    );
    try {
      const chunks = await run(openaiCompletions, {
        model: "m",
        baseURL: `${http.url}/v1`,
        apiKey: "k",
      });
      assertEquals(answer(chunks).usage, { type: "usage", input: 100, output: 5, ...cache });
    } finally {
      await http.close();
    }
  }
});
