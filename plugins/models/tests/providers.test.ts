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
  };
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
  // A cache point: providers that cache only where told (Anthropic) mark it.
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
  settings: Omit<LlmRequest, "connection" | "messages"> = {},
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
    assertEquals(body.input, [
      { role: "user", content: "roll a die" },
      { role: "assistant", content: "Rolling." },
      { type: "function_call", call_id: "c0", name: "roll", arguments: '{"sides":6}' },
      { type: "function_call_output", call_id: "c0", output: "4" },
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
